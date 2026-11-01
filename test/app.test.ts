import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

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
  it('creates the admin user from the environment, without any token', async () => {
    await bootstrapAdmin();

    const users = db.select().from(schema.users).all();
    expect(users).toHaveLength(1);
    expect(users[0].login).toBe('admin');
    expect(users[0].role).toBe('admin');

    const tokens = db.select().from(schema.tokens).all();
    expect(tokens).toHaveLength(0);
  });

  it('is idempotent across multiple invocations', async () => {
    await bootstrapAdmin();
    await bootstrapAdmin();

    expect(db.select().from(schema.users).all()).toHaveLength(1);
    expect(db.select().from(schema.tokens).all()).toHaveLength(0);
  });

  it('generates and prints a one-time password when ADMIN_PASS is unset', async () => {
    const prevUser = config.ADMIN_USER;
    config.ADMIN_USER = 'generated-admin';
    config.ADMIN_PASS = undefined;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await bootstrapAdmin();

      expect(db.select().from(schema.users).all()).toHaveLength(2);
      expect(
        db.select().from(schema.users).where(eq(schema.users.login, 'generated-admin')).all()[0]
          ?.role,
      ).toBe('admin');
      const printed = write.mock.calls.map((call) => String(call[0])).join('');
      expect(printed).toMatch(/ADMIN PASSWORD/);
      const password = /===\n(\S+)\n===/.exec(printed)?.[1];
      expect(password).toBeDefined();
    } finally {
      write.mockRestore();
      config.ADMIN_USER = prevUser;
    }
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
