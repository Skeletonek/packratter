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

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

interface LoginResult {
  status: number;
  cookie: string | null;
}

async function login(user: string, password: string): Promise<LoginResult> {
  const res = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: user, password },
  });
  const cookie = res.cookies.find((c) => c.name === 'pks_session');
  return { status: res.statusCode, cookie: cookie ? `${cookie.name}=${cookie.value}` : null };
}

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

  it('rejects API reads without a token but keeps /healthz and /r/* public', async () => {
    const repos = await server.inject({ method: 'GET', url: '/api/v1/repos' });
    expect(repos.statusCode).toBe(401);

    const health = await server.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
  });

  it('lets writes through with a valid token', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/v1/repos/no-such-repo/stable/packages',
      headers: { ...bearer(), 'Content-Type': 'application/octet-stream' },
      payload: Buffer.from('anything'),
    });
    // Past the auth hook: the failure is the missing repo, not auth.
    expect(res.statusCode).toBe(404);
    expect(res.json().error?.code).toBe('NOT_FOUND');
  });

  it('lets reads through with a valid token', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/repos', headers: bearer() });
    expect(res.statusCode).toBe(200);
  });
});

describe('login and sessions', () => {
  it('rejects a wrong password', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'admin', password: 'nope' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error?.code).toBe('UNAUTHORIZED');
  });

  it('sets a session cookie on login', async () => {
    const { status, cookie } = await login('admin', 'adminpass');
    expect(status).toBe(200);
    expect(cookie).toMatch(/^pks_session=pks_/);
  });

  it('reads and writes with the session cookie', async () => {
    const { cookie } = await login('admin', 'adminpass');
    expect(cookie).not.toBeNull();

    const read = await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookie as string },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.login).toBe('admin');

    const repos = await server.inject({
      method: 'GET',
      url: '/api/v1/repos',
      headers: { cookie: cookie as string },
    });
    expect(repos.statusCode).toBe(200);
  });

  it('removes the session on logout', async () => {
    const { cookie } = await login('admin', 'adminpass');
    const out = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookie as string },
    });
    expect(out.statusCode).toBe(200);

    const after = await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookie as string },
    });
    expect(after.statusCode).toBe(401);
  });

  it('rejects a mangled cookie value', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: 'pks_session=pks_garbage' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('api keys', () => {
  it('lists, creates, and revokes own keys', async () => {
    const create = await server.inject({
      method: 'POST',
      url: '/api/v1/keys',
      headers: bearer(),
    });
    expect(create.statusCode).toBe(201);
    const created = create.json().data;
    expect(created.token).toMatch(/^pkt_/);

    const list = await server.inject({ method: 'GET', url: '/api/v1/keys', headers: bearer() });
    const listed = list.json().data as { id: string; prefix: string; token?: string }[];
    expect(listed.some((key) => key.id === created.id)).toBe(true);
    expect(listed.every((key) => key.token === undefined)).toBe(true);

    const usable = await server.inject({
      method: 'GET',
      url: '/api/v1/repos',
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(usable.statusCode).toBe(200);

    const revoke = await server.inject({
      method: 'DELETE',
      url: `/api/v1/keys/${created.id}`,
      headers: bearer(),
    });
    expect(revoke.statusCode).toBe(200);
    const after = await server.inject({
      method: 'GET',
      url: '/api/v1/repos',
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('scopes key listings to the signed-in user', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(),
      payload: { login: 'peer', password: 'peerpassword1' },
    });
    const peerSession = await login('peer', 'peerpassword1');
    expect(peerSession.cookie).not.toBeNull();

    const peerKeys = await server.inject({
      method: 'GET',
      url: '/api/v1/keys',
      headers: { cookie: peerSession.cookie as string },
    });
    expect(peerKeys.json().data).toEqual([]);
  });
});

describe('user management', () => {
  it('rejects non-admins from user management', async () => {
    const peerSession = await login('peer', 'peerpassword1');
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { cookie: peerSession.cookie as string },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code).toBe('FORBIDDEN');
  });

  it('creates a user with a generated password and lists it', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(),
      payload: { login: 'newuser', email: 'newuser@example.com', password: 'plainuserpass' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.password).toBe('plainuserpass');

    const listed = await server.inject({ method: 'GET', url: '/api/v1/users', headers: bearer() });
    const names = (listed.json().data as { login: string }[]).map((user) => user.login);
    expect(names).toContain('newuser');
  });

  it('guards self-deletion and the last admin', async () => {
    const adminRow = db.select().from(schema.users).where(eq(schema.users.login, 'admin')).all()[0];

    const self = await server.inject({
      method: 'DELETE',
      url: `/api/v1/users/${adminRow.id}`,
      headers: bearer(),
    });
    expect(self.statusCode).toBe(409);
    expect(self.json().error?.code).toBe('CONFLICT');
  });

  it('removes a user and cascades their keys and sessions', async () => {
    const target = db.select().from(schema.users).where(eq(schema.users.login, 'peer')).all()[0];
    const peerSession = await login('peer', 'peerpassword1');
    expect(peerSession.cookie).not.toBeNull();

    const res = await server.inject({
      method: 'DELETE',
      url: `/api/v1/users/${target.id}`,
      headers: bearer(),
    });
    expect(res.statusCode).toBe(200);

    expect(db.select().from(schema.users).where(eq(schema.users.id, target.id)).all()).toEqual([]);
    expect(
      db.select().from(schema.tokens).where(eq(schema.tokens.userId, target.id)).all(),
    ).toEqual([]);

    const session = await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: peerSession.cookie as string },
    });
    expect(session.statusCode).toBe(401);
  });

  it('changes the own password and signs in with it', async () => {
    const wrong = await server.inject({
      method: 'POST',
      url: '/api/v1/me/password',
      headers: bearer(),
      payload: { current: 'wrongpass', next: 'brandnewpass1' },
    });
    expect(wrong.statusCode).toBe(401);

    const change = await server.inject({
      method: 'POST',
      url: '/api/v1/me/password',
      headers: bearer(),
      payload: { current: 'adminpass', next: 'brandnewpass1' },
    });
    expect(change.statusCode).toBe(200);

    const relogin = await login('admin', 'brandnewpass1');
    expect(relogin.status).toBe(200);
  });
});

describe('profile changes', () => {
  it('changes display name and login, guarding duplicates', async () => {
    const renamed = await server.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: bearer(),
      payload: { displayName: 'Root Operator' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().data.displayName).toBe('Root Operator');

    const clash = await server.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: bearer(),
      payload: { login: 'newuser' },
    });
    expect(clash.statusCode).toBe(409);

    const newLogin = await server.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: bearer(),
      payload: { login: 'chief' },
    });
    expect(newLogin.statusCode).toBe(200);
    expect(newLogin.json().data.login).toBe('chief');

    // old login no longer exists; new one signs in
    const oldLogin = await login('admin', 'brandnewpass1');
    expect(oldLogin.status).toBe(401);
    const newLoginRes = await login('chief', 'brandnewpass1');
    expect(newLoginRes.status).toBe(200);

    const cleared = await server.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { ...bearer(), 'Content-Type': 'application/json' },
      payload: { displayName: '' },
    });
    expect(cleared.json().data.displayName).toBe(null);
  });

  it('lets admins set login and display name for others', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(),
      payload: { login: 'teammate', password: 'teammatepass' },
    });
    const created = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.login, 'teammate'))
      .all()[0];
    expect(created!.displayName).toBeNull();

    const patch = await server.inject({
      method: 'PATCH',
      url: `/api/v1/users/${created!.id}`,
      headers: bearer(),
      payload: { displayName: 'The Teammate', login: 'teammate2' },
    });
    expect(patch.statusCode).toBe(200);
    const updated = db.select().from(schema.users).where(eq(schema.users.id, created!.id)).all()[0];
    expect(updated.displayName).toBe('The Teammate');
    expect(updated.login).toBe('teammate2');
  });

  it('lets admins reset a user password once', async () => {
    const teammate2 = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.login, 'teammate2'))
      .all()[0];

    const asUser = await login('teammate2', 'teammatepass');
    expect(asUser.cookie).not.toBeNull();
    const forbidden = await server.inject({
      method: 'POST',
      url: `/api/v1/users/${teammate2!.id}/password`,
      headers: { cookie: asUser.cookie as string },
    });
    // plain users cannot reset anyone's password — including their own
    expect(forbidden.statusCode).toBe(403);

    const reset = await server.inject({
      method: 'POST',
      url: `/api/v1/users/${teammate2!.id}/password`,
      headers: bearer(),
    });
    expect(reset.statusCode).toBe(200);
    const newPassword = reset.json().data.password;
    expect(reset.json().data.login).toBe('teammate2');

    const relogin = await login('teammate2', newPassword);
    expect(relogin.status).toBe(200);
    const oldPass = await login('teammate2', 'teammatepass');
    expect(oldPass.status).toBe(401);

    // the session from before the reset is gone
    const stale = await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: asUser.cookie as string },
    });
    expect(stale.statusCode).toBe(401);
  });
});
