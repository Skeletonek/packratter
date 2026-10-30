import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { generateToken } from '../src/auth/tokens.js';
import { applyMigrations, db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { buildServer } from '../src/server.js';
import { buildPacmanPackage, pacmanFilename, waitForJob } from './helpers.js';

let token = '';
let server: FastifyInstance;
const repoName = 'envs-test-repo';

const fixtures = new Map<string, Buffer>();
function fixture(pkgname: string): Buffer {
  let bytes = fixtures.get(pkgname);
  if (!bytes) {
    bytes = buildPacmanPackage(pkgname);
    fixtures.set(pkgname, bytes);
  }
  return bytes;
}

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

async function uploadAndWait(env: string, pkgname: string): Promise<void> {
  const res = await server.inject({
    method: 'PUT',
    url: `/api/v1/repos/${repoName}/${env}/packages`,
    headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
    payload: fixture(pkgname),
  });
  expect(res.statusCode).toBe(202);
  const job = await waitForJob(server, auth(), res.json().data.jobId);
  expect(job.status).toBe('done');
}

async function servedSha256(env: string, filename: string): Promise<string> {
  const res = await server.inject({ method: 'GET', url: `/r/${repoName}/${env}/${filename}` });
  expect(res.statusCode).toBe(200);
  return createHash('sha256').update(res.rawPayload).digest('hex');
}

describe.skipIf(process.env.RUN_FULL_TESTS !== '1')('Envs, diff, and promote', () => {
  it('creates a repo with the implicit stable env', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/repos',
      headers: auth(),
      payload: { name: repoName, type: 'pacman' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.envs).toEqual([expect.objectContaining({ name: 'stable' })]);
  });

  it('creates a testing env and rejects invalid or duplicate names', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${repoName}/envs`,
      headers: auth(),
      payload: { name: 'testing' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toEqual(expect.objectContaining({ name: 'testing' }));

    const invalid = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${repoName}/envs`,
      headers: auth(),
      payload: { name: 'No Spaces' },
    });
    expect(invalid.statusCode).toBe(400);

    const duplicate = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${repoName}/envs`,
      headers: auth(),
      payload: { name: 'testing' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error?.code).toBe('CONFLICT');
  });

  it('reports the diff between two envs', async () => {
    await uploadAndWait('testing', 'alpha-pkg');
    await uploadAndWait('testing', 'beta-pkg');
    await uploadAndWait('stable', 'alpha-pkg');

    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoName}/diff?from=testing&to=stable`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.onlyInFrom.map((p: { filename: string }) => p.filename)).toEqual([
      pacmanFilename('beta-pkg'),
    ]);
    expect(data.onlyInTo).toEqual([]);
    expect(data.different).toEqual([]);
  });

  it('promotes selected packages and yields a byte-identical set', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${repoName}/promote`,
      headers: auth(),
      payload: { from: 'testing', to: 'stable', filenames: [pacmanFilename('beta-pkg')] },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().data).toEqual({ jobId: expect.any(String), promoted: 1, skipped: 0 });
    const job = await waitForJob(server, auth(), res.json().data.jobId);
    expect(job.status).toBe('done');

    expect(await servedSha256('stable', pacmanFilename('beta-pkg'))).toBe(
      await servedSha256('testing', pacmanFilename('beta-pkg')),
    );
  });

  it('promotes all remaining and skips packages already present', async () => {
    await uploadAndWait('testing', 'gamma-pkg');

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${repoName}/promote`,
      headers: auth(),
      payload: { from: 'testing', to: 'stable' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().data).toEqual({ jobId: expect.any(String), promoted: 1, skipped: 2 });
    const job = await waitForJob(server, auth(), res.json().data.jobId);
    expect(job.status).toBe('done');

    for (const pkgname of ['alpha-pkg', 'beta-pkg', 'gamma-pkg']) {
      expect(await servedSha256('stable', pacmanFilename(pkgname))).toBe(
        await servedSha256('testing', pacmanFilename(pkgname)),
      );
    }

    const again = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${repoName}/promote`,
      headers: auth(),
      payload: { from: 'testing', to: 'stable' },
    });
    expect(again.statusCode).toBe(202);
    expect(again.json().data).toEqual({ jobId: null, promoted: 0, skipped: 3 });
  });

  it('lists and filters job history', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/jobs?repo=${repoName}&env=testing`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const jobs = res.json().data as { envId: string }[];
    expect(jobs.length).toBeGreaterThan(0);

    const repo = await server.inject({ method: 'GET', url: `/api/v1/repos/${repoName}` });
    const testingEnvId = repo
      .json()
      .data.envs.find((e: { name: string }) => e.name === 'testing').id;
    for (const job of jobs) {
      expect(job.envId).toBe(testingEnvId);
    }
  });

  it('retries a finished job and persists its log', async () => {
    const list = await server.inject({
      method: 'GET',
      url: `/api/v1/jobs?repo=${repoName}&env=stable`,
      headers: auth(),
    });
    const job = (list.json().data as { id: string; status: string }[]).find(
      (j) => j.status === 'done',
    );
    expect(job).toBeTruthy();

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/jobs/${job!.id}/retry`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(202);
    const retried = await waitForJob(server, auth(), res.json().data.jobId);
    expect(retried.status).toBe('done');
    expect(retried.log).not.toBe('');
  });
});
