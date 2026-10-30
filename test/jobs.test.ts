import { randomUUID } from 'node:crypto';
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

function seedJob(id: string, status: string, createdAt: number): void {
  db.insert(schema.jobs)
    .values({ id, repoId: null, envId: null, kind: 'rebuild', status, log: `log ${id}`, createdAt })
    .run();
}

function auth(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('jobs API', () => {
  const older = randomUUID();
  const newer = randomUUID();

  it('lists jobs newest first with pagination', async () => {
    seedJob(older, 'error', 1000);
    seedJob(newer, 'done', 2000);

    const res = await server.inject({ method: 'GET', url: '/api/v1/jobs' });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    const ids = json.data.map((j: { id: string }) => j.id);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
    expect(json.pagination).toEqual({ page: 1, pageSize: 50, total: expect.any(Number) });
  });

  it('returns a single job with its log', async () => {
    const res = await server.inject({ method: 'GET', url: `/api/v1/jobs/${newer}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.log).toBe(`log ${newer}`);
  });

  it('rejects the env filter without a repo filter', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/jobs?env=stable' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects retrying unknown, running, or orphaned jobs', async () => {
    const missing = await server.inject({
      method: 'POST',
      url: `/api/v1/jobs/${randomUUID()}/retry`,
      headers: auth(),
    });
    expect(missing.statusCode).toBe(404);

    const runningId = randomUUID();
    seedJob(runningId, 'running', 3000);
    const running = await server.inject({
      method: 'POST',
      url: `/api/v1/jobs/${runningId}/retry`,
      headers: auth(),
    });
    expect(running.statusCode).toBe(409);

    const orphanId = randomUUID();
    seedJob(orphanId, 'error', 4000);
    const orphan = await server.inject({
      method: 'POST',
      url: `/api/v1/jobs/${orphanId}/retry`,
      headers: auth(),
    });
    expect(orphan.statusCode).toBe(400);
  });
});
