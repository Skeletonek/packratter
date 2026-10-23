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
let flatpakRepoId = '';

function auth(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function commandExists(cmd: string): boolean {
  return spawnSync('which', [cmd], { encoding: 'utf8' }).status === 0;
}

function hasPlatform(): boolean {
  return spawnSync('flatpak', ['info', 'org.freedesktop.Platform/x86_64/24.08'], { encoding: 'utf8' }).status === 0;
}

function buildTestBundle(): Buffer {
  const base = mkdtempSync(join(tmpdir(), 'packrat-flatpak-'));

  const appRoot = join(base, 'app-root');
  mkdirSync(join(appRoot, 'files', 'bin'), { recursive: true });
  writeFileSync(
    join(appRoot, 'files', 'bin', 'hello'),
    '#!/bin/sh\necho hello\n',
  );
  spawnSync('chmod', ['+x', join(appRoot, 'files', 'bin', 'hello')]);
  writeFileSync(
    join(appRoot, 'metadata'),
    '[Application]\nname=org.test.App\nruntime=org.freedesktop.Platform/x86_64/24.08\nsdk=org.freedesktop.Platform/x86_64/24.08\ncommand=hello\n',
  );

  const appDir = join(base, 'appdir');
  mkdirSync(appDir, { recursive: true });
  const init = spawnSync(
    'flatpak',
    ['build-init', appDir, 'org.test.App', 'org.freedesktop.Platform/x86_64/24.08', 'org.freedesktop.Platform/x86_64/24.08'],
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
  );
  if (init.status !== 0) {
    throw new Error(`flatpak build-init failed: ${init.stderr}`);
  }
  spawnSync('cp', ['-r', join(appRoot, 'files'), join(appDir, 'files')]);
  spawnSync('cp', [join(appRoot, 'metadata'), join(appDir, 'metadata')]);

  const finish = spawnSync('flatpak', ['build-finish', appDir, '--command=hello'], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (finish.status !== 0) {
    throw new Error(`flatpak build-finish failed: ${finish.stderr}`);
  }

  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  spawnSync('ostree', ['init', '--repo', repo, '--mode', 'archive-z2'], { encoding: 'utf8' });
  const exportApp = spawnSync('flatpak', ['build-export', repo, appDir, 'master'], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (exportApp.status !== 0) {
    throw new Error(`flatpak build-export failed: ${exportApp.stderr}`);
  }

  const bundlePath = join(base, 'test.flatpak');
  const bundle = spawnSync('flatpak', ['build-bundle', repo, bundlePath, 'org.test.App', 'master'], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (bundle.status !== 0) {
    throw new Error(`flatpak build-bundle failed: ${bundle.stderr}`);
  }

  const bytes = readFileSync(bundlePath);
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

describe.skipIf(process.env.RUN_FULL_TESTS !== '1')('Flatpak repos', () => {
  it('creates a flatpak repo with the implicit stable env', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/repos',
      headers: auth(),
      payload: { name: 'flatpak-test-repo', type: 'flatpak' },
    });

    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.success).toBe(true);
    expect(json.data.type).toBe('flatpak');
    expect(json.data.envs).toEqual([expect.objectContaining({ name: 'stable' })]);
    flatpakRepoId = json.data.id;
  });

  it('returns a usable flatpak setup snippet', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/repos/${flatpakRepoId}/stable/setup-snippet`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    const snippet = res.json().data;
    expect(snippet).toContain('flatpak remote-add');
    expect(snippet).toContain('/flatpak/ostree/');
    expect(snippet).toContain('flatpak install');
  });

  it('rejects an invalid bundle with VALIDATION_ERROR', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: `/api/v1/repos/${flatpakRepoId}/stable/packages`,
      headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
      payload: Buffer.from('not a flatpak bundle'),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('VALIDATION_ERROR');
  });

  it('imports a bundle, rebuilds, and serves summary/signature files', async () => {
    const bundle = buildTestBundle();

    const uploadRes = await server.inject({
      method: 'PUT',
      url: `/api/v1/repos/${flatpakRepoId}/stable/packages`,
      headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
      payload: bundle,
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

    const summaryRes = await server.inject({ method: 'GET', url: `/r/${flatpakRepoId}/stable/flatpak/ostree/summary` });
    expect(summaryRes.statusCode).toBe(200);

    const summarySigRes = await server.inject({ method: 'GET', url: `/r/${flatpakRepoId}/stable/flatpak/ostree/summary.sig` });
    expect(summarySigRes.statusCode).toBe(200);
  });


});
