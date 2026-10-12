import { rmSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { applyMigrations, db, sqlite } from '../src/db/index.js';
import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import * as schema from '../src/db/schema.js';
import { buildServer } from '../src/server.js';
import { config } from '../src/config.js';

beforeAll(() => {
  applyMigrations();
});

afterAll(() => {
  sqlite.close();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

describe('config', () => {
  it('reads required admin credentials from the environment', () => {
    expect(config.ADMIN_USER).toBe('admin');
    expect(config.ADMIN_PASS).toBe('adminpass');
    expect(config.PORT).toBe(8080);
    expect(config.NODE_ENV).toBe('test');
  });
});

describe('bootstrapAdmin', () => {
  it('creates the admin user and a token on first run', async () => {
    await bootstrapAdmin();

    const users = db.select().from(schema.users).all();
    expect(users).toHaveLength(1);
    expect(users[0].login).toBe('admin');
    expect(users[0].role).toBe('admin');

    const tokens = db.select().from(schema.tokens).all();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].scopes).toBe('admin');
    expect(tokens[0].prefix).toHaveLength(12);
  });

  it('is idempotent across multiple invocations', async () => {
    await bootstrapAdmin();
    await bootstrapAdmin();

    expect(db.select().from(schema.users).all()).toHaveLength(1);
    expect(db.select().from(schema.tokens).all()).toHaveLength(1);
  });
});

describe('health', () => {
  it('returns ok', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });
});
