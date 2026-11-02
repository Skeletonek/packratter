import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { generateToken } from '../src/auth/tokens.js';
import { applyMigrations, db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { nowSeconds } from '../src/lib/time.js';
import { buildServer } from '../src/server.js';

let server: FastifyInstance;
const tokens: Record<string, string> = {};
const repoA = 'access-repo-a';
const repoB = 'access-repo-b';

function auth(login: string): Record<string, string> {
  return { authorization: `Bearer ${tokens[login]}` };
}

async function mintToken(userId: string): Promise<string> {
  const { token, prefix, hash } = await generateToken();
  db.insert(schema.tokens)
    .values({ id: randomUUID(), userId, prefix, hash, scopes: 'admin', createdAt: nowSeconds() })
    .run();
  return token;
}

function createUser(login: string): string {
  const id = randomUUID();
  db.insert(schema.users)
    .values({ id, login, passHash: null, role: 'user', createdAt: nowSeconds() })
    .run();
  return id;
}

beforeAll(async () => {
  applyMigrations();
  await bootstrapAdmin();
  const admin = db.select().from(schema.users).where(eq(schema.users.login, 'admin')).all()[0];
  if (!admin) throw new Error('admin user missing');
  tokens.admin = await mintToken(admin.id);

  const aliceId = createUser('alice');
  const bobId = createUser('bob');
  const carolId = createUser('carol');
  tokens.alice = await mintToken(aliceId);
  tokens.bob = await mintToken(bobId);
  tokens.carol = await mintToken(carolId);

  // Fixture rows directly in the DB: these tests exercise access control, so
  // no GPG keygen or package tooling may be required to run them.
  for (const name of [repoA, repoB]) {
    const repoId = randomUUID();
    const envId = randomUUID();
    db.insert(schema.repos)
      .values({ id: repoId, name, type: 'pacman', createdAt: nowSeconds() })
      .run();
    db.insert(schema.envs).values({ id: envId, repoId, name: 'stable' }).run();
    db.insert(schema.packages)
      .values({
        id: randomUUID(),
        envId,
        filename: `${name}-1.0-1-x86_64.pkg.tar.zst`,
        version: '1.0-1',
        arch: 'x86_64',
        size: 1,
        sha256: name,
        status: 'done',
        createdAt: nowSeconds(),
      })
      .run();
    db.insert(schema.jobs)
      .values({
        id: randomUUID(),
        repoId,
        envId,
        kind: 'rebuild',
        status: 'done',
        log: '',
        createdAt: nowSeconds(),
      })
      .run();
    if (name === repoA) {
      db.insert(schema.repoMembers).values({ repoId, userId: aliceId, role: 'viewer' }).run();
      db.insert(schema.repoMembers).values({ repoId, userId: bobId, role: 'maintainer' }).run();
    }
  }

  server = buildServer();
});

describe('per-repo access', () => {
  it('scopes the repo list to grants', async () => {
    const visible = async (login: string) => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/repos',
        headers: auth(login),
      });
      expect(res.statusCode).toBe(200);
      return res
        .json()
        .data.map((row: { name: string }) => row.name)
        .sort();
    };

    expect(await visible('admin')).toEqual([repoA, repoB]);
    expect(await visible('alice')).toEqual([repoA]);
    expect(await visible('bob')).toEqual([repoA]);
    expect(await visible('carol')).toEqual([]);
  });

  it('makes ungranted repos indistinguishable from missing ones', async () => {
    for (const login of ['alice', 'bob', 'carol']) {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/repos/${repoB}`,
        headers: auth(login),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }

    const ok = await server.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoA}`,
      headers: auth('alice'),
    });
    expect(ok.statusCode).toBe(200);
  });

  it('lets viewers read packages and the env diff', async () => {
    const pkgs = await server.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoA}/stable/packages`,
      headers: auth('alice'),
    });
    expect(pkgs.statusCode).toBe(200);
    expect(pkgs.json().data).toHaveLength(1);

    const diff = await server.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoA}/diff?from=stable&to=stable`,
      headers: auth('alice'),
    });
    expect(diff.statusCode).toBe(200);

    for (const url of [
      `/api/v1/repos/${repoA}/stable/packages`,
      `/api/v1/repos/${repoA}/diff?from=stable&to=stable`,
      `/api/v1/repos/${repoB}/stable/packages`,
    ]) {
      const res = await server.inject({ method: 'GET', url, headers: auth('carol') });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('scopes the job list and job detail', async () => {
    const jobs = async (login: string) => {
      const res = await server.inject({ method: 'GET', url: '/api/v1/jobs', headers: auth(login) });
      expect(res.statusCode).toBe(200);
      return res.json().data;
    };

    const adminJobs = await jobs('admin');
    expect(adminJobs.length).toBeGreaterThanOrEqual(2);
    expect(await jobs('carol')).toEqual([]);

    const aliceJobs = await jobs('alice');
    expect(aliceJobs.length).toBeGreaterThanOrEqual(1);
    const aliceJob = aliceJobs[0];
    const jobRes = await server.inject({
      method: 'GET',
      url: `/api/v1/jobs/${aliceJob.id}`,
      headers: auth('alice'),
    });
    expect(jobRes.statusCode).toBe(200);

    const carolJobRes = await server.inject({
      method: 'GET',
      url: `/api/v1/jobs/${aliceJob.id}`,
      headers: auth('carol'),
    });
    expect(carolJobRes.statusCode).toBe(404);
  });

  it('lets maintainers write envs but not viewers or the ungranted', async () => {
    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${repoA}/envs`,
      headers: { ...auth('bob'), 'Content-Type': 'application/json' },
      payload: { name: 'testing' },
    });
    expect(created.statusCode).toBe(201);

    const viewer = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${repoA}/envs`,
      headers: { ...auth('alice'), 'Content-Type': 'application/json' },
      payload: { name: 'nope' },
    });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json().error.code).toBe('FORBIDDEN');

    const ungranted = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${repoA}/envs`,
      headers: { ...auth('carol'), 'Content-Type': 'application/json' },
      payload: { name: 'nope' },
    });
    expect(ungranted.statusCode).toBe(404);
  });

  it('rejects uploads from viewers and the ungranted before any tooling runs', async () => {
    const viewer = await server.inject({
      method: 'PUT',
      url: `/api/v1/repos/${repoA}/stable/packages`,
      headers: { ...auth('alice'), 'Content-Type': 'application/octet-stream' },
      payload: Buffer.from('irrelevant'),
    });
    expect(viewer.statusCode).toBe(403);

    const ungranted = await server.inject({
      method: 'PUT',
      url: `/api/v1/repos/${repoA}/stable/packages`,
      headers: { ...auth('carol'), 'Content-Type': 'application/octet-stream' },
      payload: Buffer.from('irrelevant'),
    });
    expect(ungranted.statusCode).toBe(404);

    // The maintainer passes the access guard; whether the toolchain can then
    // take the upload depends on the environment (host vs container).
    const maintainer = await server.inject({
      method: 'PUT',
      url: `/api/v1/repos/${repoA}/stable/packages`,
      headers: { ...auth('bob'), 'Content-Type': 'application/octet-stream' },
      payload: Buffer.from('irrelevant'),
    });
    expect(maintainer.statusCode).not.toBe(403);
    expect(maintainer.statusCode).not.toBe(404);
  });

  it('keeps repo lifecycle verbs admin-only', async () => {
    for (const login of ['bob', 'alice']) {
      const patch = await server.inject({
        method: 'PATCH',
        url: `/api/v1/repos/${repoA}`,
        headers: { ...auth(login), 'Content-Type': 'application/json' },
        payload: { branchMode: 'env' },
      });
      expect(patch.statusCode, login).toBe(403);

      const del = await server.inject({
        method: 'DELETE',
        url: `/api/v1/repos/${repoA}`,
        headers: auth(login),
      });
      expect(del.statusCode, login).toBe(403);
    }

    const create = await server.inject({
      method: 'POST',
      url: '/api/v1/repos',
      headers: { ...auth('bob'), 'Content-Type': 'application/json' },
      payload: { name: 'access-created', type: 'pacman' },
    });
    expect(create.statusCode).toBe(403);
  });

  it('manages members as admin only', async () => {
    const list = await server.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoA}/members`,
      headers: auth('admin'),
    });
    expect(list.statusCode).toBe(200);
    expect(
      list
        .json()
        .data.map((m: { login: string }) => m.login)
        .sort(),
    ).toEqual(['alice', 'bob']);

    const add = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${repoA}/members`,
      headers: { ...auth('admin'), 'Content-Type': 'application/json' },
      payload: { login: 'carol', role: 'viewer' },
    });
    expect(add.statusCode).toBe(201);

    const promoted = await server.inject({
      method: 'PATCH',
      url: `/api/v1/repos/${repoA}/members/carol`,
      headers: { ...auth('admin'), 'Content-Type': 'application/json' },
      payload: { role: 'maintainer' },
    });
    expect(promoted.statusCode).toBe(200);

    const carolCreate = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${repoB}/envs`,
      headers: { ...auth('carol'), 'Content-Type': 'application/json' },
      payload: { name: 'nope' },
    });
    expect(carolCreate.statusCode).toBe(404);

    const removed = await server.inject({
      method: 'DELETE',
      url: `/api/v1/repos/${repoA}/members/carol`,
      headers: auth('admin'),
    });
    expect(removed.statusCode).toBe(200);

    for (const [method, url] of [
      ['GET', `/api/v1/repos/${repoA}/members`],
      ['POST', `/api/v1/repos/${repoA}/members`],
      ['PATCH', `/api/v1/repos/${repoA}/members/alice`],
      ['DELETE', `/api/v1/repos/${repoA}/members/alice`],
    ] as const) {
      const res = await server.inject({
        method,
        url,
        headers: { ...auth('bob'), 'Content-Type': 'application/json' },
        payload: method === 'GET' ? undefined : { login: 'carol', role: 'viewer' },
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});
