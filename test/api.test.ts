import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { generateToken } from '../src/auth/tokens.js';
import { applyMigrations, db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { buildServer } from '../src/server.js';
import { buildPacmanPackage, pacmanFilename } from './helpers.js';

let token = '';
let server: FastifyInstance;
let repoName = '';

function auth(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
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
    repoName = json.data.name;
    expect(json.data.envs).toEqual([expect.objectContaining({ name: 'stable' })]);
  });

  it('lists packages of /:repo/stable — the exact route the UI and repo page hit', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoName}/stable/packages`,
      headers: auth(),
    });

    // Used to fail with NOT_FOUND/env not found when the route matched envs by UUID
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, data: [] });
  });

  it('404s for a nonexistent env name with NOT_FOUND', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoName}/testing/packages`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error?.code).toBe('NOT_FOUND');
  });

  it('exposes the repo public key as armored text in the public /r/ zone', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/stable/gpg-public-key`,
    });
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
  });

  it('accepts package uploads with pacman archive content types and rejects invalid bodies with VALIDATION_ERROR', async () => {
    for (const contentType of ['application/octet-stream', 'application/zstd']) {
      const res = await server.inject({
        method: 'PUT',
        url: `/api/v1/repos/${repoName}/stable/packages`,
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
      url: `/api/v1/repos/${repoName}/stable/setup-snippet`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    const snippet = res.json().data;
    expect(snippet).toContain(`[api-test-repo]`);
    expect(snippet).toContain('keyfile=$(mktemp)');
    expect(snippet).toContain('curl -fsSL');
    expect(snippet).toContain('sudo pacman-key --add "$keyfile"');
    expect(snippet).toContain('sudo pacman-key --lsign-key');
    expect(snippet).toContain(`Server = ${`http://localhost:5000`}/r/${repoName}/stable`);
    expect(snippet).toContain('SigLevel = Required DatabaseOptional');
  });

  it('uploads a real package, rebuilds, and serves db/package/signature files', async () => {
    const pkgBytes = buildPacmanPackage('package-test', '0.12.0');
    const uploadRes = await server.inject({
      method: 'PUT',
      url: `/api/v1/repos/${repoName}/stable/packages`,
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

    const dbRes = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/stable/api-test-repo.db`,
    });
    expect(dbRes.statusCode).toBe(200);

    const dbSigRes = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/stable/api-test-repo.db.sig`,
    });
    expect(dbSigRes.statusCode).toBe(200);

    const pkgRes = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/stable/${pacmanFilename('package-test', '0.12.0')}`,
    });
    expect(pkgRes.statusCode).toBe(200);

    const pkgSigRes = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/stable/${pacmanFilename('package-test', '0.12.0')}.sig`,
    });
    expect(pkgSigRes.statusCode).toBe(200);
  });
});
