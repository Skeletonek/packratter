import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// A stub discovery endpoint on a fixed port; SSO_* env vars must exist before
// src/config.ts is imported, then applyMigrations seeds the DB row from them.
const TEST_PORT = vi.hoisted(() => {
  process.env.SSO_ISSUER = 'http://127.0.0.1:18924';
  process.env.SSO_CLIENT_ID = 'packratter-test';
  process.env.SSO_CLIENT_SECRET = 'shh';
  return 18924;
});

import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { generateToken } from '../src/auth/tokens.js';
import { applyMigrations, db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { nowSeconds } from '../src/lib/time.js';
import { buildServer } from '../src/server.js';
import { buildPacmanPackage, waitForJob } from './helpers.js';

let server: FastifyInstance;
let idp: Server;
const tokens: Record<string, string> = {};

function auth(login: string): Record<string, string> {
  return { authorization: `Bearer ${tokens[login] ?? tokens.admin}` };
}

beforeAll(async () => {
  idp = createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        authorization_endpoint: `http://127.0.0.1:${TEST_PORT}/authorize`,
        token_endpoint: `http://127.0.0.1:${TEST_PORT}/token`,
        userinfo_endpoint: `http://127.0.0.1:${TEST_PORT}/userinfo`,
      }),
    );
  });
  await new Promise<void>((resolve) => idp.listen(TEST_PORT, '127.0.0.1', resolve));

  applyMigrations();
  await bootstrapAdmin();
  tokens.admin = (await mint('admin'))!;
  for (const login of ['mori', 'viewer']) {
    const id = randomUUID();
    db.insert(schema.users)
      .values({ id, login, passHash: null, role: 'user', createdAt: nowSeconds() })
      .run();
    tokens[login] = await mint(login);
  }
  server = buildServer();
});

afterAll(async () => {
  await new Promise<void>((resolve) => idp.close(() => resolve()));
});

async function mint(login: string): Promise<string | null> {
  const user = db.select().from(schema.users).where(eq(schema.users.login, login)).all()[0];
  if (!user) return null;
  const { token, prefix, hash } = await generateToken();
  db.insert(schema.tokens)
    .values({
      id: randomUUID(),
      userId: user.id,
      prefix,
      hash,
      scopes: 'admin',
      createdAt: nowSeconds(),
    })
    .run();
  return token;
}

describe('settings env view', () => {
  it('shows values but only a configured flag for secrets', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/settings/env',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);

    const entries = res.json().data as { key: string; value: string | null; configured: boolean }[];
    const port = entries.find((e) => e.key === 'PORT');
    expect(port?.value).toBe('8080');
    expect(port?.configured).toBe(true);

    const pass = entries.find((e) => e.key === 'ADMIN_PASS');
    expect(pass?.value).toBeNull();
    expect(pass?.configured).toBe(true);

    // no secret value ever slips into the payload
    expect(res.body).not.toContain('adminpass');
  });

  it('is admin-only', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/settings/env',
      headers: auth('mori'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});

describe('settings sso view and updates', () => {
  it('masks the secret and reports seeded-from-env', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/settings/sso',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.exists).toBe(true);
    expect(data.enabled).toBe(true);
    expect(data.seededFromEnv).toBe(true);
    expect(data.issuer).toBe(`http://127.0.0.1:${TEST_PORT}`);
    expect(data.hasSecret).toBe(true);
    expect(res.body).not.toContain('shh');
  });

  it('updates the DB row and keeps the secret when omitted', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/v1/settings/sso',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      payload: {
        issuer: `http://127.0.0.1:${TEST_PORT}/sub`,
        clientId: 'renamed',
        autoCreate: false,
      },
    });
    expect(res.statusCode).toBe(200);

    const data = res.json().data;
    expect(data.issuer).toBe(`http://127.0.0.1:${TEST_PORT}/sub`);
    expect(data.clientId).toBe('renamed');
    expect(data.autoCreate).toBe(false);
    expect(data.hasSecret).toBe(true);

    const row = db.select().from(schema.ssoConfig).all()[0];
    expect(row.clientSecret).toBe('shh');
    expect(row.seededFromEnv).toBe(true);
  });

  it('requires claim and value to be written as a pair', async () => {
    const one = await server.inject({
      method: 'PUT',
      url: '/api/v1/settings/sso',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      payload: { issuer: `http://127.0.0.1:${TEST_PORT}`, clientId: 'x', adminClaim: 'roles' },
    });
    expect(one.statusCode).toBe(400);
    expect(one.json().error.message).toContain('together');
  });

  it('treats an empty admin claim as clearing the grant', async () => {
    const clear = await server.inject({
      method: 'PUT',
      url: '/api/v1/settings/sso',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      payload: {
        issuer: `http://127.0.0.1:${TEST_PORT}`,
        clientId: 'packratter-test',
        adminClaim: '',
        adminValue: '',
      },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().data.adminClaim).toBeNull();
  });

  it('rejects a first configuration without a client secret', async () => {
    db.delete(schema.ssoConfig).run();
    const none = await server.inject({
      method: 'PUT',
      url: '/api/v1/settings/sso',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      payload: { issuer: `http://127.0.0.1:${TEST_PORT}`, clientId: 'x' },
    });
    expect(none.statusCode).toBe(400);
    expect(none.json().error.message).toContain('secret is required');

    const created = await server.inject({
      method: 'PUT',
      url: '/api/v1/settings/sso',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      payload: {
        issuer: `http://127.0.0.1:${TEST_PORT}`,
        clientId: 'x',
        clientSecret: 'new-secret',
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().data.exists).toBe(true);
    expect(created.json().data.seededFromEnv).toBe(false);
    expect(created.json().data.hasSecret).toBe(true);
  });

  it('tests discovery for draft values', async () => {
    const ok = await server.inject({
      method: 'POST',
      url: '/api/v1/settings/sso/test',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      payload: { issuer: `http://127.0.0.1:${TEST_PORT}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.ok).toBe(true);
    expect(ok.json().data.authorizationEndpoint).toContain('/authorize');

    const bad = await server.inject({
      method: 'POST',
      url: '/api/v1/settings/sso/test',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      payload: { issuer: 'http://127.0.0.1:1' },
    });
    expect(bad.statusCode).toBe(200);
    expect(bad.json().data.ok).toBe(false);
    expect(typeof bad.json().data.error).toBe('string');
  });
});

describe.skipIf(process.env.RUN_FULL_TESTS !== '1')('settings keys view', () => {
  it('lists the generated key of a real repository', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/repos',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      payload: { name: 'settings-keys-repo', type: 'pacman' },
    });
    expect(created.statusCode).toBe(201);

    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/settings/keys',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);

    const key = res.json().data.find((k: { repo: string }) => k.repo === 'settings-keys-repo');
    expect(key).toBeDefined();
    expect(key.fingerprint).toMatch(/^[A-F0-9]{40}$/);
    expect(typeof key.algorithm === 'string' || key.algorithm === null).toBe(true);
    expect(key.publicKey).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
    expect(key.createdAt).toBeGreaterThan(0);
    expect(key.publicKey).not.toMatch(/private/i);
  });

  it('round-trips an upload with the listed key as the signing key', async () => {
    const upload = await server.inject({
      method: 'PUT',
      url: '/api/v1/repos/settings-keys-repo/stable/packages',
      headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
      payload: buildPacmanPackage('settings-key-app'),
    });
    expect(upload.statusCode).toBe(202);
    const job = await waitForJob(server, auth(), upload.json().data.jobId);
    expect(job.status).toBe('done');
  });
});
