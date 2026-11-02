import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The SSO config must exist before src/config.ts is imported, and the stub
// provider needs a fixed URL for the same reason.
const SSO_PORT = vi.hoisted(() => {
  process.env.SSO_ISSUER = 'http://127.0.0.1:18923';
  process.env.SSO_CLIENT_ID = 'packratter-test';
  process.env.SSO_CLIENT_SECRET = 'shh';
  return 18923;
});

import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { codeChallenge, decodePending, resolveSsoUser, type SsoPolicy } from '../src/auth/sso.js';
import { generateToken } from '../src/auth/tokens.js';
import { applyMigrations, db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { nowSeconds } from '../src/lib/time.js';
import { buildServer } from '../src/server.js';

let server: FastifyInstance;
let idp: Server;
let userinfo: Record<string, unknown> = {};

const base: SsoPolicy = { autoCreate: true, adminClaim: null, adminValue: null };
const claimPolicy: SsoPolicy = {
  autoCreate: true,
  adminClaim: 'realm_access.roles',
  adminValue: 'packratter-admin',
};

function userByLogin(login: string) {
  return db.select().from(schema.users).where(eq(schema.users.login, login)).all()[0];
}

function seedUser(
  login: string,
  role: string,
  extra: Partial<typeof schema.users.$inferInsert> = {},
) {
  const id = randomUUID();
  db.insert(schema.users)
    .values({ id, login, passHash: null, role, createdAt: nowSeconds(), ...extra })
    .run();
  return db.select().from(schema.users).where(eq(schema.users.id, id)).all()[0];
}

function setRole(userId: string, role: string): void {
  db.update(schema.users).set({ role }).where(eq(schema.users.id, userId)).run();
}

async function mintToken(userId: string): Promise<string> {
  const { token, prefix, hash } = await generateToken();
  db.insert(schema.tokens)
    .values({ id: randomUUID(), userId, prefix, hash, scopes: 'admin', createdAt: nowSeconds() })
    .run();
  return token;
}

interface StartResult {
  state: string;
  cookie: string;
}

async function startFlow(): Promise<StartResult> {
  const res = await server.inject({ method: 'GET', url: '/api/v1/auth/sso/start' });
  expect(res.statusCode).toBe(302);
  const cookie = res.cookies.find((c) => c.name === 'pks_sso');
  if (!cookie) throw new Error('no state cookie');
  return {
    state: decodePending(cookie.value)?.state ?? '',
    cookie: `${cookie.name}=${cookie.value}`,
  };
}

async function callbackWith(start: StartResult, query: string) {
  return server.inject({
    method: 'GET',
    url: `/api/v1/auth/sso/callback?${query}`,
    headers: { cookie: start.cookie },
  });
}

beforeAll(async () => {
  idp = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${SSO_PORT}`);
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      json(200, {
        authorization_endpoint: `http://127.0.0.1:${SSO_PORT}/authorize`,
        token_endpoint: `http://127.0.0.1:${SSO_PORT}/token`,
        userinfo_endpoint: `http://127.0.0.1:${SSO_PORT}/userinfo`,
      });
    } else if (url.pathname === '/token') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const params = new URLSearchParams(body);
        if (
          params.get('code') !== 'test-code' ||
          !params.get('code_verifier') ||
          params.get('client_secret') !== 'shh'
        ) {
          json(400, { error: 'invalid_grant' });
          return;
        }
        json(200, { access_token: 'stub-token' });
      });
    } else if (url.pathname === '/userinfo') {
      if (req.headers.authorization !== 'Bearer stub-token') {
        json(401, { error: 'unauthorized' });
        return;
      }
      json(200, userinfo);
    } else {
      json(404, {});
    }
  });
  await new Promise<void>((resolve) => idp.listen(SSO_PORT, '127.0.0.1', resolve));

  applyMigrations();
  await bootstrapAdmin();
  server = buildServer();
});

afterAll(async () => {
  await new Promise<void>((resolve) => idp.close(() => resolve()));
});

describe('SSO sign-in flow', () => {
  it('reports itself as enabled and starts with PKCE and a state cookie', async () => {
    const status = await server.inject({ method: 'GET', url: '/api/v1/auth/sso/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json().data).toEqual({ enabled: true });

    const res = await server.inject({ method: 'GET', url: '/api/v1/auth/sso/start' });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin).toBe(`http://127.0.0.1:${SSO_PORT}`);
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');

    const cookie = res.cookies.find((c) => c.name === 'pks_sso');
    const pending = decodePending(cookie?.value);
    expect(pending).not.toBeNull();
    expect(location.searchParams.get('state')).toBe(pending!.state);
    expect(location.searchParams.get('code_challenge')).toBe(codeChallenge(pending!.verifier));
  });

  it('provisions an account on first sign-in', async () => {
    userinfo = {
      sub: 'sub-jit-1',
      email: 'jit1@example.com',
      preferred_username: 'jit.one',
      name: 'Jit One',
    };
    const start = await startFlow();
    const res = await callbackWith(start, `code=test-code&state=${start.state}`);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(res.cookies.find((c) => c.name === 'pks_session')).toBeDefined();

    const user = userByLogin('jit.one');
    expect(user).toBeDefined();
    expect(user.ssoSub).toBe('sub-jit-1');
    expect(user.passHash).toBeNull();
    expect(user.role).toBe('user');
  });

  it('links an existing account by email', async () => {
    seedUser('local.user', 'user', { email: 'linked@example.com' });
    userinfo = { sub: 'sub-link-1', email: 'linked@example.com', preferred_username: 'ignored' };
    const start = await startFlow();
    const res = await callbackWith(start, `code=test-code&state=${start.state}`);

    expect(res.statusCode).toBe(302);
    const user = userByLogin('local.user');
    expect(user.ssoSub).toBe('sub-link-1');
    expect(userByLogin('ignored')).toBeUndefined();
  });

  it('rejects a callback with a mismatched state', async () => {
    userinfo = { sub: 'sub-state-1', email: 'state1@example.com' };
    const start = await startFlow();
    const res = await callbackWith(start, 'code=test-code&state=someone-elses-state');

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?sso=failed');
    expect(res.cookies.find((c) => c.name === 'pks_session')).toBeUndefined();
  });

  it('refuses local password sign-in for SSO-only accounts', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'jit.one', password: 'whatever' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toContain('no local password');
  });
});

describe('resolveSsoUser policy', () => {
  it('grants admin from a claim, including nested and array forms', () => {
    const nested = resolveSsoUser(
      { sub: 'sub-claim-1', realm_access: { roles: ['packratter-admin'] } },
      claimPolicy,
    );
    expect(nested.user.role).toBe('admin');
    expect(nested.created).toBe(true);

    const flat = { ...claimPolicy, adminClaim: 'roles' };
    const array = resolveSsoUser({ sub: 'sub-claim-2', roles: ['x', 'packratter-admin'] }, flat);
    expect(array.user.role).toBe('admin');

    const plain = resolveSsoUser({ sub: 'sub-claim-3', roles: 'packratter-admin' }, flat);
    expect(plain.user.role).toBe('admin');
  });

  it('syncs the role up and down at each sign-in while the claim manages it', () => {
    seedUser('claim.sync', 'user', { ssoSub: 'sub-sync' });
    resolveSsoUser({ sub: 'sub-sync' }, base);
    expect(userByLogin('claim.sync').role).toBe('user');

    const up = resolveSsoUser(
      { sub: 'sub-sync', realm_access: { roles: ['packratter-admin'] } },
      claimPolicy,
    );
    expect(up.user.role).toBe('admin');

    // Claim gone: demoted again, because other admins exist.
    resolveSsoUser({ sub: 'sub-sync' }, claimPolicy);
    expect(userByLogin('claim.sync').role).toBe('user');
  });

  it('never demotes the last admin', () => {
    const target = seedUser('claim.last', 'admin', { ssoSub: 'sub-last' });
    const otherAdmins = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.role, 'admin'))
      .all()
      .filter((u) => u.id !== target.id);
    for (const other of otherAdmins) setRole(other.id, 'user');

    resolveSsoUser({ sub: 'sub-last' }, claimPolicy);
    expect(userByLogin('claim.last').role).toBe('admin');

    for (const other of otherAdmins) setRole(other.id, 'admin');
  });

  it('ignores the claim once an admin hand-edited the role', () => {
    seedUser('claim.manual', 'user', { ssoSub: 'sub-manual', roleManaged: true });

    resolveSsoUser(
      { sub: 'sub-manual', realm_access: { roles: ['packratter-admin'] } },
      claimPolicy,
    );
    expect(userByLogin('claim.manual').role).toBe('user');

    db.update(schema.users)
      .set({ role: 'admin' })
      .where(eq(schema.users.login, 'claim.manual'))
      .run();
    resolveSsoUser({ sub: 'sub-manual' }, claimPolicy);
    expect(userByLogin('claim.manual').role).toBe('admin');
  });

  it('denies unknown identities when auto-create is off', () => {
    expect(() =>
      resolveSsoUser(
        { sub: 'sub-unknown', email: 'unknown@example.com' },
        { ...base, autoCreate: false },
      ),
    ).toThrow(/no account exists/);
    expect(userByLogin('unknown')).toBeUndefined();
  });
});

describe('user management of SSO accounts', () => {
  it('marks manual role edits so the claim stops managing them', async () => {
    const admin = userByLogin('admin');
    const target = userByLogin('claim.sync');
    const res = await server.inject({
      method: 'PATCH',
      url: `/api/v1/users/${target.id}`,
      headers: {
        authorization: `Bearer ${await mintToken(admin.id)}`,
        'Content-Type': 'application/json',
      },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);

    const after = userByLogin('claim.sync');
    expect(after.role).toBe('admin');
    expect(after.roleManaged).toBe(true);
  });
});
