import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { generateToken } from '../src/auth/tokens.js';
import { totpCode } from '../src/auth/totp.js';
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

async function login(user: string, password: string) {
  return server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: user, password },
  });
}

describe('audit trail', () => {
  // Direct row inserts keep this suite host-safe: only the audited verbs go
  // through the API, no toolchain-backed rebuilds involved.
  function insertRepo(name: string, envNames: string[]): string {
    const repoId = randomUUID();
    db.insert(schema.repos).values({ id: repoId, name, type: 'pacman', createdAt: 1 }).run();
    for (const envName of envNames) {
      db.insert(schema.envs).values({ id: randomUUID(), repoId, name: envName }).run();
    }
    return repoId;
  }

  it('records repo and env lifecycle actions with actor and subject', async () => {
    const repoName = `audit-repo-${randomUUID().slice(0, 8)}`;
    insertRepo(repoName, ['alpha', 'beta']);

    // env.delete on a two-env repo first; env.rename goes last because renames
    // enqueue a rebuild and the repo-wide job guard blocks later deletes.
    const delEnv = await server.inject({
      method: 'DELETE',
      url: `/api/v1/repos/${repoName}/envs/beta`,
      headers: bearer(),
    });
    expect(delEnv.statusCode).toBe(200);

    const repo2Name = `audit-repo2-${randomUUID().slice(0, 8)}`;
    insertRepo(repo2Name, ['stable']);
    const patch = await server.inject({
      method: 'PATCH',
      url: `/api/v1/repos/${repo2Name}`,
      headers: bearer(),
      payload: { allUsers: true },
    });
    expect(patch.statusCode).toBe(200);
    const delRepo = await server.inject({
      method: 'DELETE',
      url: `/api/v1/repos/${repo2Name}`,
      headers: bearer(),
    });
    expect(delRepo.statusCode).toBe(200);

    const rename = await server.inject({
      method: 'PATCH',
      url: `/api/v1/repos/${repoName}/envs/alpha`,
      headers: bearer(),
      payload: { name: 'renamed' },
    });
    expect(rename.statusCode).toBe(200);

    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/audit?limit=200',
      headers: bearer(),
    });
    expect(res.statusCode).toBe(200);
    const entries = res.json().data as {
      action: string;
      actorLogin: string;
      subjectLabel: string | null;
    }[];
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('repo.delete');
    expect(actions).toContain('repo.update');
    expect(actions).toContain('env.rename');
    expect(actions).toContain('env.delete');
    for (const entry of entries) {
      expect(entry.actorLogin).toBe('admin');
    }
    const envDelete = entries.find((e) => e.action === 'env.delete');
    expect(envDelete?.subjectLabel).toContain(repoName);
  });

  it('records user management and token actions', async () => {
    const loginName = `audit-user-${randomUUID().slice(0, 8)}`;
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(),
      payload: { login: loginName },
    });
    expect(createRes.statusCode).toBe(201);
    const user = createRes.json().data;

    await server.inject({
      method: 'PATCH',
      url: `/api/v1/users/${user.id}`,
      headers: bearer(),
      payload: { role: 'admin' },
    });
    await server.inject({
      method: 'POST',
      url: `/api/v1/users/${user.id}/password`,
      headers: bearer(),
    });
    const keyRes = await server.inject({
      method: 'POST',
      url: '/api/v1/keys',
      headers: bearer(),
      payload: {},
    });
    expect(keyRes.statusCode).toBe(201);
    await server.inject({
      method: 'DELETE',
      url: `/api/v1/keys/${keyRes.json().data.id}`,
      headers: bearer(),
    });
    await server.inject({
      method: 'DELETE',
      url: `/api/v1/users/${user.id}`,
      headers: bearer(),
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/audit?limit=200',
      headers: bearer(),
    });
    const entries = res.json().data as {
      action: string;
      details: Record<string, unknown> | null;
    }[];
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('user.create');
    expect(actions).toContain('user.update');
    expect(actions).toContain('user.password_reset');
    expect(actions).toContain('token.create');
    expect(actions).toContain('token.revoke');
    expect(actions).toContain('user.delete');

    const userUpdate = entries.find((e) => e.action === 'user.update');
    expect(userUpdate?.details).toMatchObject({ role: 'admin' });
  });

  it('records own password changes', async () => {
    const loginName = `audit-self-${randomUUID().slice(0, 8)}`;
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(),
      payload: { login: loginName, password: 'firstpass1' },
    });
    const user = createRes.json().data;
    const cookie = (await login(loginName, 'firstpass1')).cookies.find(
      (c) => c.name === 'pks_session',
    );
    expect(cookie).toBeDefined();

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/me/password',
      headers: { cookie: `pks_session=${cookie!.value}` },
      payload: { current: 'firstpass1', next: 'secondpass1' },
    });
    expect(res.statusCode).toBe(200);

    const audit = await server.inject({
      method: 'GET',
      url: '/api/v1/audit?q=' + user.id,
      headers: bearer(),
    });
    const entries = audit.json().data as { action: string; actorLogin: string }[];
    const change = entries.find((e) => e.action === 'user.password_change');
    expect(change?.actorLogin).toBe(loginName);
  });

  it('filters by action and actor', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/audit?action=token.&actor=admin&limit=200',
      headers: bearer(),
    });
    expect(res.statusCode).toBe(200);
    const entries = res.json().data as { action: string; actorLogin: string }[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.action).toContain('token.');
      expect(entry.actorLogin).toContain('admin');
    }
  });

  it('is admin-only', async () => {
    const loginName = `audit-plain-${randomUUID().slice(0, 8)}`;
    await server.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(),
      payload: { login: loginName, password: 'plainpass1' },
    });
    // the plain user creates their own key, then asks for the admin-only trail
    const cookie = (await login(loginName, 'plainpass1')).cookies.find(
      (c) => c.name === 'pks_session',
    );
    const keyRes = await server.inject({
      method: 'POST',
      url: '/api/v1/keys',
      headers: { cookie: `pks_session=${cookie!.value}` },
      payload: {},
    });
    const plainKey = keyRes.json().data.token;

    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/audit',
      headers: { authorization: `Bearer ${plainKey}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('sessions', () => {
  it('lists own sessions with a current marker', async () => {
    const loginName = `sess-${randomUUID().slice(0, 8)}`;
    await server.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(),
      payload: { login: loginName, password: 'sesspass1' },
    });
    const cookie = (await login(loginName, 'sesspass1')).cookies.find(
      (c) => c.name === 'pks_session',
    );

    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/sessions',
      headers: { cookie: `pks_session=${cookie!.value}` },
    });
    expect(res.statusCode).toBe(200);
    const sessions = res.json().data as {
      id: string;
      current: boolean;
      userAgent: string | null;
    }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].current).toBe(true);
  });

  it('revokes a single session and revoke-all ends the caller too', async () => {
    const loginName = `sess2-${randomUUID().slice(0, 8)}`;
    await server.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(),
      payload: { login: loginName, password: 'sesspass1' },
    });
    const first = (await login(loginName, 'sesspass1')).cookies.find(
      (c) => c.name === 'pks_session',
    );
    const second = (await login(loginName, 'sesspass1')).cookies.find(
      (c) => c.name === 'pks_session',
    );
    expect(first?.value).not.toBe(second?.value);

    const listRes = await server.inject({
      method: 'GET',
      url: '/api/v1/sessions',
      headers: { cookie: `pks_session=${first!.value}` },
    });
    const sessions = listRes.json().data as { id: string; current: boolean }[];
    expect(sessions).toHaveLength(2);
    const other = sessions.find((s) => !s.current)!;

    const revokeRes = await server.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${other.id}`,
      headers: { cookie: `pks_session=${first!.value}` },
    });
    expect(revokeRes.statusCode).toBe(200);

    // the revoked session no longer authenticates
    const gone = await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `pks_session=${second!.value}` },
    });
    expect(gone.statusCode).toBe(401);

    const allRes = await server.inject({
      method: 'POST',
      url: '/api/v1/sessions/revoke-all',
      headers: { cookie: `pks_session=${first!.value}` },
    });
    expect(allRes.statusCode).toBe(200);
    const after = await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `pks_session=${first!.value}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('refuses to revoke another user session', async () => {
    const loginName = `sess3-${randomUUID().slice(0, 8)}`;
    await server.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(),
      payload: { login: loginName, password: 'sesspass1' },
    });
    const mine = (await login(loginName, 'sesspass1')).cookies.find(
      (c) => c.name === 'pks_session',
    );
    const adminCookie = (await login('admin', 'adminpass')).cookies.find(
      (c) => c.name === 'pks_session',
    );

    const mineList = await server.inject({
      method: 'GET',
      url: '/api/v1/sessions',
      headers: { cookie: `pks_session=${mine!.value}` },
    });
    const mySessionId = (mineList.json().data as { id: string }[])[0].id;

    const res = await server.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${mySessionId}`,
      headers: { cookie: `pks_session=${adminCookie!.value}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('api key expiry', () => {
  it('rejects an expired token', async () => {
    const { token: expired, prefix, hash } = await generateToken();
    const admin = db.select().from(schema.users).where(eq(schema.users.login, 'admin')).all()[0];
    db.insert(schema.tokens)
      .values({
        id: randomUUID(),
        userId: admin.id,
        prefix,
        hash,
        scopes: 'admin',
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      })
      .run();

    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a key with a future expiry and reports it', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/keys',
      headers: bearer(),
      payload: { expiresInDays: 30 },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json().data;
    expect(created.expiresAt).toBeGreaterThan(Date.now());

    const listRes = await server.inject({ method: 'GET', url: '/api/v1/keys', headers: bearer() });
    const rows = listRes.json().data as {
      id: string;
      expiresAt: number | null;
      lastUsedAt: number | null;
    }[];
    const row = rows.find((r) => r.id === created.id)!;
    expect(row.expiresAt).toBeGreaterThan(0);

    // last-used is tracked on authenticated calls
    await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${created.token}` },
    });
    const afterRes = await server.inject({ method: 'GET', url: '/api/v1/keys', headers: bearer() });
    const after = (afterRes.json().data as { id: string; lastUsedAt: number | null }[]).find(
      (r) => r.id === created.id,
    )!;
    expect(after.lastUsedAt).not.toBeNull();
  });
});

describe('two-factor login', () => {
  it('requires a TOTP code when enrolled and accepts recovery codes', async () => {
    const loginName = `totp-${randomUUID().slice(0, 8)}`;
    await server.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(),
      payload: { login: loginName, password: 'totppass1' },
    });
    const cookie = (await login(loginName, 'totppass1')).cookies.find(
      (c) => c.name === 'pks_session',
    );
    const authed = { cookie: `pks_session=${cookie!.value}` };

    // factor enrollment needs password proof, not just the session
    const noPass = await server.inject({
      method: 'POST',
      url: '/api/v1/me/2fa/totp/setup',
      headers: authed,
      payload: {},
    });
    expect(noPass.statusCode).toBe(401);

    const setupRes = await server.inject({
      method: 'POST',
      url: '/api/v1/me/2fa/totp/setup',
      headers: authed,
      payload: { password: 'totppass1' },
    });
    expect(setupRes.statusCode).toBe(200);
    const secret = setupRes.json().data.secret as string;

    // confirm spends its code's time-step; the login below uses the next one.
    // TOTP stays off until the recovery codes are confirmed saved.
    const confirmRes = await server.inject({
      method: 'POST',
      url: '/api/v1/me/2fa/totp/confirm',
      headers: authed,
      payload: { code: totpCode(secret, Date.now() - 30_000) },
    });
    expect(confirmRes.statusCode).toBe(200);
    const recoveryCodes = confirmRes.json().data.recoveryCodes as string[];
    expect(recoveryCodes).toHaveLength(10);

    // not active yet: plain login still works
    const premature = await login(loginName, 'totppass1');
    expect(premature.statusCode).toBe(200);

    const activateRes = await server.inject({
      method: 'POST',
      url: '/api/v1/me/2fa/totp/activate',
      headers: authed,
    });
    expect(activateRes.statusCode).toBe(200);

    // password alone no longer gets a session
    const step1 = await login(loginName, 'totppass1');
    expect(step1.statusCode).toBe(401);
    const challenge = step1.json().error;
    expect(challenge.code).toBe('2FA_REQUIRED');
    expect(challenge.methods).toContain('totp');

    // wrong code fails
    const wrongRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login/totp',
      payload: { pendingToken: challenge.pendingToken, code: '000000' },
    });
    expect(wrongRes.statusCode).toBe(401);

    // a real code completes the login
    const okRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login/totp',
      payload: { pendingToken: challenge.pendingToken, code: totpCode(secret) },
    });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.cookies.find((c) => c.name === 'pks_session')).toBeDefined();

    // the same code cannot be replayed on another pending login
    const step1b = await login(loginName, 'totppass1');
    const replayRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login/totp',
      payload: { pendingToken: step1b.json().error.pendingToken, code: totpCode(secret) },
    });
    expect(replayRes.statusCode).toBe(401);

    // a recovery code works once, then is spent
    const step2 = await login(loginName, 'totppass1');
    const challenge2 = step2.json().error;
    const recRes = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login/totp',
      payload: { pendingToken: challenge2.pendingToken, code: recoveryCodes[0] },
    });
    expect(recRes.statusCode).toBe(200);

    const step3 = await login(loginName, 'totppass1');
    const challenge3 = step3.json().error;
    const recAgain = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login/totp',
      payload: { pendingToken: challenge3.pendingToken, code: recoveryCodes[0] },
    });
    expect(recAgain.statusCode).toBe(401);
  });

  it('an admin password reset disables TOTP and restores password-only login', async () => {
    const loginName = `reset-${randomUUID().slice(0, 8)}`;
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(),
      payload: { login: loginName, password: 'resetpass1' },
    });
    const user = createRes.json().data;
    const cookie = (await login(loginName, 'resetpass1')).cookies.find(
      (c) => c.name === 'pks_session',
    );
    const authed = { cookie: `pks_session=${cookie!.value}` };

    const setupRes = await server.inject({
      method: 'POST',
      url: '/api/v1/me/2fa/totp/setup',
      headers: authed,
      payload: { password: 'resetpass1' },
    });
    const secret = setupRes.json().data.secret as string;
    await server.inject({
      method: 'POST',
      url: '/api/v1/me/2fa/totp/confirm',
      headers: authed,
      payload: { code: totpCode(secret) },
    });
    await server.inject({ method: 'POST', url: '/api/v1/me/2fa/totp/activate', headers: authed });

    const resetRes = await server.inject({
      method: 'POST',
      url: `/api/v1/users/${user.id}/password`,
      headers: bearer(),
    });
    expect(resetRes.statusCode).toBe(200);
    const newPassword = resetRes.json().data.password as string;

    // reset clears the factor: plain login works again
    const after = await login(loginName, newPassword);
    expect(after.statusCode).toBe(200);
    expect(after.cookies.find((c) => c.name === 'pks_session')).toBeDefined();
  });

  it('activates TOTP only after the recovery codes step', async () => {
    const loginName = `gate-${randomUUID().slice(0, 8)}`;
    await server.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(),
      payload: { login: loginName, password: 'gatepass1' },
    });
    const cookie = (await login(loginName, 'gatepass1')).cookies.find(
      (c) => c.name === 'pks_session',
    );
    const authed = { cookie: `pks_session=${cookie!.value}` };

    // activation before confirming codes is refused
    const early = await server.inject({
      method: 'POST',
      url: '/api/v1/me/2fa/totp/activate',
      headers: authed,
    });
    expect(early.statusCode).toBe(400);

    const setupRes = await server.inject({
      method: 'POST',
      url: '/api/v1/me/2fa/totp/setup',
      headers: authed,
      payload: { password: 'gatepass1' },
    });
    const secret = setupRes.json().data.secret as string;
    await server.inject({
      method: 'POST',
      url: '/api/v1/me/2fa/totp/confirm',
      headers: authed,
      payload: { code: totpCode(secret) },
    });

    // codes issued, still not active: status reports the pending state
    const statusRes = await server.inject({
      method: 'GET',
      url: '/api/v1/me/2fa',
      headers: authed,
    });
    const status = statusRes.json().data;
    expect(status.totpEnabled).toBe(false);
    expect(status.totpPending).toBe(true);

    const activateRes = await server.inject({
      method: 'POST',
      url: '/api/v1/me/2fa/totp/activate',
      headers: authed,
    });
    expect(activateRes.statusCode).toBe(200);
    const afterRes = await server.inject({ method: 'GET', url: '/api/v1/me/2fa', headers: authed });
    expect(afterRes.json().data.totpEnabled).toBe(true);
  });

  it('an admin password reset also removes webauthn credentials', async () => {
    const loginName = `reset2-${randomUUID().slice(0, 8)}`;
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: bearer(),
      payload: { login: loginName, password: 'resetpass1' },
    });
    const user = createRes.json().data;
    db.insert(schema.webauthnCredentials)
      .values({
        id: randomUUID(),
        userId: user.id,
        publicKey: 'ZmFrZQ==',
        counter: 0,
        label: 'stolen key',
        createdAt: Math.floor(Date.now() / 1000),
      })
      .run();

    const resetRes = await server.inject({
      method: 'POST',
      url: `/api/v1/users/${user.id}/password`,
      headers: bearer(),
    });
    expect(resetRes.statusCode).toBe(200);

    const keys = db
      .select()
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.userId, user.id))
      .all();
    expect(keys).toHaveLength(0);
  });
});
