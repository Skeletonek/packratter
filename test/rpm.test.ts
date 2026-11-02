import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
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
import * as rpm from '../src/formats/rpm.js';
import { buildRpmPackage } from './helpers.js';

let token = '';
let server: FastifyInstance;
let repoName = '';

function auth(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function commandExists(cmd: string): boolean {
  return !spawnSync(cmd, ['--version'], { encoding: 'utf8' }).error;
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

describe('rpm format', () => {
  it('marks rpm files immutable and repodata no-cache', () => {
    expect(rpm.serveHeaders('/data/repos/x/y/rpm/packages/a.rpm')).toEqual({
      'cache-control': 'max-age=31536000, immutable',
    });
    expect(rpm.serveHeaders('/data/repos/x/y/rpm/repodata/repomd.xml')).toEqual({
      'cache-control': 'no-cache',
    });
  });

  it('produces a setup snippet with a .repo file and repo_gpgcheck', () => {
    const snippet = rpm.setupSnippet('myrepo', 'http://localhost:5000', 'stable', 'fpr');
    expect(snippet).toContain('/etc/yum.repos.d/myrepo.repo');
    expect(snippet).toContain('baseurl=http://localhost:5000/r/myrepo/stable/rpm');
    expect(snippet).toContain('repo_gpgcheck=1');
    expect(snippet).toContain('gpgkey=http://localhost:5000/r/myrepo/stable/gpg-public-key');
    expect(snippet).not.toContain('dnf install');
  });

  it('rejects garbage without touching rpm', () => {
    const tmp = join(tmpdir(), `packrat-rpm-garbage-${randomUUID()}.rpm`);
    writeFileSync(tmp, 'not an rpm package');
    try {
      expect(rpm.validate(tmp)).toEqual({ ok: false, error: 'not a valid RPM package' });
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});

describe.skipIf(
  process.env.RUN_FULL_TESTS !== '1' ||
    !commandExists('rpm') ||
    !commandExists('rpmbuild') ||
    !commandExists('createrepo_c'),
)('Rpm repos', () => {
  it('creates an rpm repo with the implicit stable env', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/repos',
      headers: auth(),
      payload: { name: 'rpm-test-repo', type: 'rpm' },
    });

    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.success).toBe(true);
    expect(json.data.type).toBe('rpm');
    expect(json.data.envs).toEqual([expect.objectContaining({ name: 'stable' })]);
    repoName = json.data.name;
  });

  it('rejects an invalid package with VALIDATION_ERROR', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: `/api/v1/repos/${repoName}/stable/packages`,
      headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
      payload: Buffer.from('not an rpm package'),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('VALIDATION_ERROR');
  });

  it('uploads a real package, rebuilds, and serves repodata/package files', async () => {
    const uploadRes = await server.inject({
      method: 'PUT',
      url: `/api/v1/repos/${repoName}/stable/packages`,
      headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
      payload: buildRpmPackage(),
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

    const repomd = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/stable/rpm/repodata/repomd.xml`,
    });
    expect(repomd.statusCode).toBe(200);

    const repomdSig = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/stable/rpm/repodata/repomd.xml.asc`,
    });
    expect(repomdSig.statusCode).toBe(200);
    expect(repomdSig.body).toContain('-----BEGIN PGP SIGNATURE-----');

    const pkgRes = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/stable/rpm/packages/package-test-0.12.0-1.noarch.rpm`,
    });
    expect(pkgRes.statusCode).toBe(200);
  });
});
