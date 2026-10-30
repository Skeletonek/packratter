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
import * as deb from '../src/formats/deb.js';
import { waitForJob } from './helpers.js';

let token = '';
let server: FastifyInstance;
let repoName = '';

function auth(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function commandExists(cmd: string): boolean {
  return !spawnSync(cmd, ['--version'], { encoding: 'utf8' }).error;
}

function buildTestDeb(): Buffer {
  const base = mkdtempSync(join(tmpdir(), 'packrat-deb-'));
  const pkgDir = join(base, 'pkg');
  mkdirSync(join(pkgDir, 'DEBIAN'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'DEBIAN', 'control'),
    'Package: guinea-mpeg\nVersion: 0.12.0-1\nArchitecture: amd64\nMaintainer: Test <test@example.com>\nDescription: Tiny test package\n',
  );
  const debPath = join(base, 'guinea-mpeg_0.12.0-1_amd64.deb');
  const result = spawnSync('dpkg-deb', ['--build', pkgDir, debPath], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`dpkg-deb --build failed: ${result.error?.message ?? result.stderr}`);
  }
  const bytes = readFileSync(debPath);
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

describe('deb format', () => {
  it('marks pool files immutable and dists metadata no-cache', () => {
    expect(deb.serveHeaders('/data/repos/x/y/deb/pool/amd64/a.deb')).toEqual({
      'cache-control': 'max-age=31536000, immutable',
    });
    expect(deb.serveHeaders('/data/repos/x/y/deb/dists/stable/InRelease')).toEqual({
      'cache-control': 'no-cache',
    });
  });

  it('produces a setup snippet with a signed-by keyring and sources.list entry', () => {
    const snippet = deb.setupSnippet('myrepo', 'http://localhost:5000', 'stable', 'fpr');
    expect(snippet).toContain('gpg --dearmor');
    expect(snippet).toContain('signed-by=/usr/share/keyrings/myrepo.gpg');
    expect(snippet).toContain(
      'deb [signed-by=/usr/share/keyrings/myrepo.gpg] http://localhost:5000/r/myrepo/stable/deb stable main',
    );
    expect(snippet).toContain('/etc/apt/sources.list.d/myrepo.list');
    expect(snippet).toContain('apt-get update');
  });

  it('rejects garbage without touching dpkg-deb', () => {
    const tmp = join(tmpdir(), `packrat-deb-garbage-${randomUUID()}.deb`);
    writeFileSync(tmp, 'not a debian package');
    try {
      expect(deb.validate(tmp)).toEqual({ ok: false, error: 'not a valid Debian package' });
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});

describe.skipIf(
  process.env.RUN_FULL_TESTS !== '1' ||
    !commandExists('dpkg-deb') ||
    !commandExists('apt-ftparchive'),
)('Deb repos', () => {
  it('creates a deb repo with the implicit stable env', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/repos',
      headers: auth(),
      payload: { name: 'deb-test-repo', type: 'deb' },
    });

    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.success).toBe(true);
    expect(json.data.type).toBe('deb');
    expect(json.data.envs).toEqual([expect.objectContaining({ name: 'stable' })]);
    repoName = json.data.name;
  });

  it('rejects an invalid package with VALIDATION_ERROR', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: `/api/v1/repos/${repoName}/stable/packages`,
      headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
      payload: Buffer.from('not a debian package'),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('VALIDATION_ERROR');
  });

  it('uploads a real package, rebuilds, and serves dists/pool files', async () => {
    const uploadRes = await server.inject({
      method: 'PUT',
      url: `/api/v1/repos/${repoName}/stable/packages`,
      headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
      payload: buildTestDeb(),
    });

    expect(uploadRes.statusCode).toBe(202);
    const jobId = uploadRes.json().data.jobId;
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

    const inRelease = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/stable/deb/dists/stable/InRelease`,
    });
    expect(inRelease.statusCode).toBe(200);
    expect(inRelease.body).toContain('-----BEGIN PGP SIGNED MESSAGE-----');

    const releaseGpg = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/stable/deb/dists/stable/Release.gpg`,
    });
    expect(releaseGpg.statusCode).toBe(200);

    const packages = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/stable/deb/dists/stable/main/binary-amd64/Packages`,
    });
    expect(packages.statusCode).toBe(200);
    expect(packages.body).toContain('Filename: pool/amd64/guinea-mpeg_0.12.0-1_amd64.deb');

    const pkgRes = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/stable/deb/pool/amd64/guinea-mpeg_0.12.0-1_amd64.deb`,
    });
    expect(pkgRes.statusCode).toBe(200);
  });

  it('promotes packages between envs byte-identically', async () => {
    const envRes = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${repoName}/envs`,
      headers: auth(),
      payload: { name: 'testing' },
    });
    expect(envRes.statusCode).toBe(201);

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${repoName}/promote`,
      headers: auth(),
      payload: { from: 'stable', to: 'testing' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().data).toEqual({ jobId: expect.any(String), promoted: 1, skipped: 0 });
    const job = await waitForJob(server, auth(), res.json().data.jobId);
    expect(job.status).toBe('done');

    const stablePkg = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/stable/deb/pool/amd64/guinea-mpeg_0.12.0-1_amd64.deb`,
    });
    const testingPkg = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/testing/deb/pool/amd64/guinea-mpeg_0.12.0-1_amd64.deb`,
    });
    expect(stablePkg.statusCode).toBe(200);
    expect(testingPkg.statusCode).toBe(200);
    expect(testingPkg.rawPayload.equals(stablePkg.rawPayload)).toBe(true);

    const index = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/testing/deb/dists/testing/main/binary-amd64/Packages`,
    });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('Filename: pool/amd64/guinea-mpeg_0.12.0-1_amd64.deb');
  });
});
