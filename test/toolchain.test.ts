import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { generateToken } from '../src/auth/tokens.js';
import { applyMigrations, db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { buildServer } from '../src/server.js';
import {
  REQUIRED_TOOLS,
  assertTypeAvailable,
  scanToolchain,
  unavailableMessage,
  type ToolchainState,
} from '../src/lib/toolchain.js';
import type { RepoType } from '../src/formats/index.js';
import { AppError } from '../src/errors.js';
import { config } from '../src/config.js';

let token = '';
let server: FastifyInstance;

beforeAll(async () => {
  applyMigrations();
  await bootstrapAdmin();
  const admin = db.select().from(schema.users).where(eq(schema.users.login, 'admin')).all()[0];
  if (!admin) throw new Error('admin user missing');

  const { token: generated, prefix, hash } = await generateToken();
  db.insert(schema.tokens)
    .values({
      id: randomUUID(),
      userId: admin.id,
      prefix,
      hash,
      scopes: 'admin',
      createdAt: Math.floor(Date.now() / 1000),
    })
    .run();
  token = generated;

  server = buildServer();
});

function auth(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('toolchain api', () => {
  it('reports per-type capability shaped as ok/missing/disabledByConfig', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/toolchain',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);

    const state = res.json().data as ToolchainState;
    for (const type of Object.keys(REQUIRED_TOOLS)) {
      expect(state[type]).toEqual({
        ok: expect.any(Boolean),
        missing: expect.any(Array),
        disabledByConfig: expect.any(Boolean),
      });
      expect(REQUIRED_TOOLS[type as RepoType]).toContain('gpg');
    }
  });
});

describe('toolchain guards', () => {
  it('rejects a type whose tools are missing', () => {
    const state: ToolchainState = {
      pacman: { ok: true, missing: [], disabledByConfig: false },
      deb: { ok: true, missing: [], disabledByConfig: false },
      rpm: { ok: false, missing: ['createrepo_c', 'gpg'], disabledByConfig: false },
      flatpak: { ok: false, missing: ['ostree', 'flatpak', 'gpg'], disabledByConfig: false },
    };

    expect(() => assertTypeAvailable('rpm', state)).toThrow(AppError);
    try {
      assertTypeAvailable('rpm', state);
    } catch (err) {
      const appError = err as AppError;
      expect(appError.statusCode).toBe(409);
      expect(appError.code).toBe('TOOLCHAIN_MISSING');
      expect(appError.message).toBe(unavailableMessage('rpm', state.rpm));
      expect(appError.message).toContain('createrepo_c');
    }
  });

  it('rejects a disabled-by-configuration type with its own code', () => {
    const config = { DISABLE_RPM: true };
    const flags: Record<RepoType, boolean> = {
      pacman: false,
      deb: false,
      rpm: config.DISABLE_RPM,
      flatpak: false,
    };
    const state: ToolchainState = {
      pacman: { ok: true, missing: [], disabledByConfig: false },
      deb: { ok: true, missing: [], disabledByConfig: false },
      rpm: { ok: false, missing: [], disabledByConfig: flags.rpm },
      flatpak: { ok: true, missing: [], disabledByConfig: false },
    };

    try {
      assertTypeAvailable('rpm', state);
      expect.unreachable();
    } catch (err) {
      const appError = err as AppError;
      expect(appError.statusCode).toBe(409);
      expect(appError.code).toBe('TYPE_DISABLED');
      expect(appError.message).toBe('rpm is disabled by configuration (DISABLE_RPM=1)');
    }
  });

  it('allows a fully-equipped type', () => {
    const state: ToolchainState = {
      pacman: { ok: false, missing: ['repo-add'], disabledByConfig: false },
      deb: { ok: false, missing: ['apt-ftparchive'], disabledByConfig: false },
      rpm: { ok: true, missing: [], disabledByConfig: false },
      flatpak: { ok: true, missing: [], disabledByConfig: false },
    };
    expect(() => assertTypeAvailable('rpm', state)).not.toThrow();
  });
});

describe('DISABLE_* flags', () => {
  it('disable a type with tools present', async () => {
    config.DISABLE_DEB = true;
    try {
      const state = await scanToolchain();
      expect(state.deb).toEqual({ ok: false, missing: state.deb.missing, disabledByConfig: true });
    } finally {
      config.DISABLE_DEB = false;
    }
  });
});

describe('scanToolchain', () => {
  it('covers every configured type and invents no unknown tool names', async () => {
    const state = await scanToolchain();

    expect(Object.keys(state).sort()).toEqual(Object.keys(REQUIRED_TOOLS).sort());
    for (const [type, tools] of Object.entries(REQUIRED_TOOLS)) {
      const missing = state[type as RepoType].missing;
      expect(missing.every((tool) => tools.includes(tool))).toBe(true);
    }
  });
});
