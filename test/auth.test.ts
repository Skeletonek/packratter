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

describe('auth', () => {
  it('rejects writes without a token', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { name: 'no-token-repo', type: 'pacman' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects writes with an invalid token', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/repos',
      headers: { authorization: 'Bearer pkt_000000000000_aaaaaaaaaaaaaaaaaaaaaaaa' },
      payload: { name: 'bad-token-repo', type: 'pacman' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error?.code).toBe('UNAUTHORIZED');
  });

  it('allows reads without a token', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/repos' });
    expect(res.statusCode).toBe(200);
    const health = await server.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
  });

  it('lets writes through with a valid token', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/v1/repos/no-such-repo/stable/packages',
      headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      payload: Buffer.from('anything'),
    });
    // Past the auth hook: the failure is the missing repo, not auth.
    expect(res.statusCode).toBe(404);
    expect(res.json().error?.code).toBe('NOT_FOUND');
  });
});
