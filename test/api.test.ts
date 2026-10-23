import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { generateToken } from '../src/auth/tokens.js';
import { applyMigrations, db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { buildServer } from '../src/server.js';

let token = '';
let server: FastifyInstance;
let repoId = '';

function auth(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function buildTestPackage(): Buffer {
  const base = mkdtempSync(join(tmpdir(), 'packrat-pkg-'));
  const cwd = join(base, 'root');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(cwd, '.PKGINFO'),
    'pkgname = guinea-mpeg\npkgver = 0.12.0-1\npkgrel = 1\narch = x86_64\n',
  );
  const pkgPath = join(base, 'guinea-mpeg-0.12.0-1-1-x86_64.pkg.tar.zst');
  const result = spawnSync('bsdtar', ['-c', '--zstd', '-f', pkgPath, '.PKGINFO'], { cwd, encoding: 'utf8' });
  if (result.status !== 0 || result.error) {
    throw new Error(`bsdtar failed: ${result.error?.message ?? result.stderr}`);
  }
  const bytes = readFileSync(pkgPath);
  rmSync(base, { recursive: true, force: true });
  return bytes;
}

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

describe.skipIf(process.env.RUN_FULL_TESTS !== '1')('API used by the repo pages', () => {
  it('creates a pacman repo with the implicit stable env', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/repos',
      headers: auth(),
      payload: { name: 'api-test-repo', type: 'pacman' },
    });

    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.success).toBe(true);
    repoId = json.data.id;
    expect(json.data.envs).toEqual([
      expect.objectContaining({ name: 'stable' }),
    ]);
  });

  it('lists packages of /:repo/stable — the exact route the UI and repo page hit', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoId}/stable/packages`,
      headers: auth(),
    });

    // Used to fail with NOT_FOUND/env not found when the route matched envs by UUID
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, data: [] });
  });

  it('404s for a nonexistent env name with NOT_FOUND', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoId}/testing/packages`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error?.code).toBe('NOT_FOUND');
  });

  it('exposes the repo public key as armored text', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoId}/stable/gpg-public-key`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
  });

  it('accepts package uploads with pacman archive content types and rejects invalid bodies with VALIDATION_ERROR', async () => {
    for (const contentType of ['application/octet-stream', 'application/zstd']) {
      const res = await server.inject({
        method: 'PUT',
        url: `/api/v1/repos/${repoId}/stable/packages`,
        headers: { ...auth(), 'Content-Type': contentType },
        payload: Buffer.from('not a valid package'),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error?.code).toBe('VALIDATION_ERROR');
    }
  });

  it('returns a usable setup snippet with key import, fingerprint and repo URL', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoId}/stable/setup-snippet`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    const snippet = res.json().data;
    expect(snippet).toContain(`[api-test-repo]`);
    expect(snippet).toContain('keyfile=$(mktemp)');
    expect(snippet).toContain('curl -fsSL');
    expect(snippet).toContain('sudo pacman-key --add "$keyfile"');
    expect(snippet).toContain('sudo pacman-key --lsign-key');
    expect(snippet).toContain(`Server = ${`http://localhost:5000`}/r/${repoId}/stable`);
    expect(snippet).toContain('SigLevel = Required DatabaseOptional');
  });

  it('uploads a real package, rebuilds, and serves db/package/signature files', async () => {
    const pkgBytes = buildTestPackage();
    const uploadRes = await server.inject({
      method: 'PUT',
      url: `/api/v1/repos/${repoId}/stable/packages`,
      headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
      payload: pkgBytes,
    });

    expect(uploadRes.statusCode).toBe(202);
    const uploadJson = uploadRes.json();
    expect(uploadJson.success).toBe(true);
    const jobId = uploadJson.data.jobId;
    expect(typeof jobId).toBe('string');

    let job: { status: string; log: string } | null = null;
    for (let i = 0; i < 60; i++) {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/jobs/${jobId}`,
        headers: auth(),
      });
      job = res.json().data;
      if (job?.status === 'done' || job?.status === 'error') break;
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(job?.status).toBe('done');

    const dbRes = await server.inject({ method: 'GET', url: `/r/${repoId}/stable/api-test-repo.db` });
    expect(dbRes.statusCode).toBe(200);

    const dbSigRes = await server.inject({ method: 'GET', url: `/r/${repoId}/stable/api-test-repo.db.sig` });
    expect(dbSigRes.statusCode).toBe(200);

    const pkgRes = await server.inject({
      method: 'GET',
      url: `/r/${repoId}/stable/guinea-mpeg-0.12.0-1-1-x86_64.pkg.tar.zst`,
    });
    expect(pkgRes.statusCode).toBe(200);

    const pkgSigRes = await server.inject({
      method: 'GET',
      url: `/r/${repoId}/stable/guinea-mpeg-0.12.0-1-1-x86_64.pkg.tar.zst.sig`,
    });
    expect(pkgSigRes.statusCode).toBe(200);
  });
});
