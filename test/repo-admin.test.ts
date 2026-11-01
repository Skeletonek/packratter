import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { generateToken } from '../src/auth/tokens.js';
import { applyMigrations, db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { buildServer } from '../src/server.js';
import { config } from '../src/config.js';

let token = '';
let userCookie = '';
let server: FastifyInstance;
let repoName = '';

interface CookieJar {
  name: string;
  value: string;
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

  await server.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: bearer(),
    payload: { login: 'teamuser', password: 'teamuserpass' },
  });
  const login = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: 'teamuser', password: 'teamuserpass' },
  });
  userCookie = sessionCookie(login.cookies);
  if (!userCookie) throw new Error('teamuser login failed');
});

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function cookieOrBearer(): Record<string, string> {
  return userCookie ? { cookie: userCookie } : bearer();
}

function sessionCookie(cookies: CookieJar[]): string | null {
  const found = cookies.find((c) => c.name === 'pks_session');
  return found ? `${found.name}=${found.value}` : null;
}

describe('repo creation env', () => {
  it('uses the requested first environment name', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/repos',
      headers: bearer(),
      payload: { name: 'env-choice-repo', type: 'pacman', env: 'products' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.envs).toEqual([{ id: expect.any(String), name: 'products' }]);
    repoName = 'env-choice-repo';
  });

  it('falls back to stable when the name is omitted', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/repos',
      headers: bearer(),
      payload: { name: 'env-default-repo', type: 'pacman' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.envs[0].name).toBe('stable');
  });
});

describe('repo list', () => {
  it('serves envs and package counts in one response', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/repos',
      headers: cookieOrBearer(),
    });
    expect(res.statusCode).toBe(200);

    const row = (
      res.json().data as {
        name: string;
        envs: { name: string }[];
        packageCount: number;
      }[]
    ).find((repo) => repo.name === repoName);
    expect(row).toBeDefined();
    expect(row?.envs.map((env) => env.name)).toEqual(['products']);
    expect(row?.packageCount).toBe(0);
  });
});

describe('env rename', () => {
  it('renames and rejects permission-less renames and duplicates', async () => {
    const ok = await server.inject({
      method: 'PATCH',
      url: `/api/v1/repos/${repoName}/envs/products`,
      headers: bearer(),
      payload: { name: 'meadow' },
    });
    expect(ok.statusCode).toBe(200);

    const asUser = await server.inject({
      method: 'PATCH',
      url: `/api/v1/repos/${repoName}/envs/meadow`,
      headers: { cookie: userCookie },
      payload: { name: 'forbidden' },
    });
    expect(asUser.statusCode).toBe(403);

    const createSecond = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${repoName}/envs`,
      headers: bearer(),
      payload: { name: 'extra' },
    });
    expect(createSecond.statusCode).toBe(201);

    const dup = await server.inject({
      method: 'PATCH',
      url: `/api/v1/repos/${repoName}/envs/extra`,
      headers: bearer(),
      payload: { name: 'meadow' },
    });
    expect(dup.statusCode).toBe(409);
  });
});

describe('deletion', () => {
  it('is admin-only for repos and envs', async () => {
    const repo = await server.inject({
      method: 'DELETE',
      url: '/api/v1/repos/env-default-repo',
      headers: { cookie: userCookie },
    });
    expect(repo.statusCode).toBe(403);

    const env = await server.inject({
      method: 'DELETE',
      url: '/api/v1/repos/env-default-repo/envs/stable',
      headers: { cookie: userCookie },
    });
    expect(env.statusCode).toBe(403);
  });

  it('refuses to delete the last environment', async () => {
    const first = await server.inject({
      method: 'DELETE',
      url: `/api/v1/repos/${repoName}/envs/extra`,
      headers: bearer(),
    });
    expect(first.statusCode).toBe(200);

    const last = await server.inject({
      method: 'DELETE',
      url: `/api/v1/repos/${repoName}/envs/meadow`,
      headers: bearer(),
    });
    expect(last.statusCode).toBe(409);
    expect(last.json().error?.code).toBe('CONFLICT');
  });

  it('blocks deletion while a job is pending and cleans disk state after', async () => {
    const jobId = randomUUID();
    const repoRow = db.select().from(schema.repos).where(eq(schema.repos.name, repoName)).all()[0];
    const envDir = join(config.DATA_DIR, 'repos', repoRow.id);
    const envRow = db.select().from(schema.envs).where(eq(schema.envs.repoId, repoRow.id)).all()[0];

    db.insert(schema.jobs)
      .values({
        id: jobId,
        repoId: repoRow.id,
        envId: envRow.id,
        kind: 'rebuild',
        status: 'running',
        log: '',
        createdAt: Math.floor(Date.now() / 1000),
      })
      .run();

    const busy = await server.inject({
      method: 'DELETE',
      url: `/api/v1/repos/${repoName}`,
      headers: bearer(),
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error?.code).toBe('REPO_BUSY');

    db.update(schema.jobs).set({ status: 'done' }).where(eq(schema.jobs.id, jobId)).run();

    expect(existsSync(envDir)).toBe(true);
    const del = await server.inject({
      method: 'DELETE',
      url: `/api/v1/repos/${repoName}`,
      headers: bearer(),
    });
    expect(del.statusCode).toBe(200);
    expect(existsSync(envDir)).toBe(false);

    const gone = await server.inject({
      method: 'GET',
      url: '/r/env-choice-repo/stable/gpg-public-key',
      headers: bearer(),
    });
    expect(gone.statusCode).toBe(404);
  });
});
