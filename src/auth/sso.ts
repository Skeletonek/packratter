import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { nowSeconds } from '../lib/time.js';

export const SSO_STATE_COOKIE = 'pks_sso';
export const STATE_TTL_SECONDS = 600;

export function ssoEnabled(): boolean {
  return Boolean(config.SSO_ISSUER && config.SSO_CLIENT_ID && config.SSO_CLIENT_SECRET);
}

// ---- discovery -----------------------------------------------------------

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

let discoveryCache: Discovery | null = null;

async function discover(): Promise<Discovery> {
  if (discoveryCache) return discoveryCache;
  const base = config.SSO_ISSUER!.replace(/\/$/, '');
  const res = await fetch(`${base}/.well-known/openid-configuration`);
  if (!res.ok) {
    throw new AppError('SSO_ERROR', `OIDC discovery failed with status ${res.status}`, 502);
  }
  const doc = (await res.json()) as Partial<Discovery>;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) {
    throw new AppError('SSO_ERROR', 'OIDC discovery document is missing required endpoints', 502);
  }
  discoveryCache = doc as Discovery;
  return discoveryCache;
}

// ---- PKCE state ----------------------------------------------------------

export interface PendingAuth {
  state: string;
  verifier: string;
}

export function newPendingAuth(): PendingAuth {
  return {
    state: randomBytes(32).toString('base64url'),
    verifier: randomBytes(32).toString('base64url'),
  };
}

export function encodePending(pending: PendingAuth): string {
  return Buffer.from(
    JSON.stringify({ ...pending, exp: nowSeconds() + STATE_TTL_SECONDS }),
  ).toString('base64url');
}

export function decodePending(cookieValue: string | undefined): PendingAuth | null {
  if (!cookieValue) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cookieValue, 'base64url').toString('utf8')) as {
      state?: unknown;
      verifier?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.state !== 'string' || typeof parsed.verifier !== 'string') return null;
    if (typeof parsed.exp !== 'number' || parsed.exp < nowSeconds()) return null;
    return { state: parsed.state, verifier: parsed.verifier };
  } catch {
    return null;
  }
}

export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ---- provider calls ------------------------------------------------------

export async function authorizationUrl(redirectUri: string, pending: PendingAuth): Promise<string> {
  const discovery = await discover();
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.SSO_CLIENT_ID!);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', config.SSO_SCOPES ?? 'openid profile email');
  url.searchParams.set('state', pending.state);
  url.searchParams.set('code_challenge', codeChallenge(pending.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<Record<string, unknown>> {
  const discovery = await discover();
  const tokenRes = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: config.SSO_CLIENT_ID!,
      client_secret: config.SSO_CLIENT_SECRET!,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) {
    throw new AppError('SSO_ERROR', `token exchange failed with status ${tokenRes.status}`, 502);
  }
  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) {
    throw new AppError('SSO_ERROR', 'token response has no access token', 502);
  }

  const userinfoRes = await fetch(discovery.userinfo_endpoint, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userinfoRes.ok) {
    throw new AppError('SSO_ERROR', `userinfo failed with status ${userinfoRes.status}`, 502);
  }
  return (await userinfoRes.json()) as Record<string, unknown>;
}

// ---- identity and role resolution ---------------------------------------

type UserRow = typeof schema.users.$inferSelect;

/** Provider behavior for one sign-in, derived from config but explicit for tests. */
export interface SsoPolicy {
  autoCreate: boolean;
  adminClaim: string | null;
  adminValue: string | null;
}

export function policyFromConfig(): SsoPolicy {
  return {
    autoCreate: config.SSO_AUTO_CREATE,
    adminClaim: config.SSO_ADMIN_CLAIM ?? null,
    adminValue: config.SSO_ADMIN_VALUE ?? null,
  };
}

function claimValue(info: Record<string, unknown>, path: string): unknown {
  let current: unknown = info;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function hasAdminClaim(info: Record<string, unknown>, policy: SsoPolicy): boolean {
  if (!policy.adminClaim || !policy.adminValue) return false;
  const value = claimValue(info, policy.adminClaim);
  if (typeof value === 'string') return value === policy.adminValue;
  if (Array.isArray(value)) return value.includes(policy.adminValue);
  return false;
}

function sanitizeLogin(text: string): string {
  const clean = text
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return clean.length > 0 ? clean : 'user';
}

function uniqueLogin(base: string): string {
  let candidate = base;
  for (let n = 2; ; n++) {
    const clash = db.select().from(schema.users).where(eq(schema.users.login, candidate)).all();
    if (clash.length === 0) return candidate;
    const suffix = `-${n}`;
    candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }
}

function adminCount(): number {
  return db.select().from(schema.users).where(eq(schema.users.role, 'admin')).all().length;
}

/**
 * Claim-managed roles: the claim grants admin on sign-in and revokes it when
 * gone — until an admin hand-edits the role (roleManaged), after which the
 * claim is ignored for that account entirely.
 */
function syncRole(user: UserRow, wantsAdmin: boolean): UserRow {
  if (user.roleManaged) return user;
  if (wantsAdmin && user.role !== 'admin') {
    db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, user.id)).run();
  } else if (!wantsAdmin && user.role === 'admin' && adminCount() > 1) {
    // Never demote the last admin, whatever the provider says.
    db.update(schema.users).set({ role: 'user' }).where(eq(schema.users.id, user.id)).run();
  }
  return db.select().from(schema.users).where(eq(schema.users.id, user.id)).all()[0];
}

export function resolveSsoUser(
  info: Record<string, unknown>,
  policy: SsoPolicy,
): { user: UserRow; created: boolean } {
  const sub = info.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new AppError('SSO_ERROR', 'userinfo response has no subject', 502);
  }
  const email = typeof info.email === 'string' && info.email.length > 0 ? info.email : null;
  const preferredUsername =
    typeof info.preferred_username === 'string' && info.preferred_username.length > 0
      ? info.preferred_username
      : null;
  const name = typeof info.name === 'string' && info.name.length > 0 ? info.name : null;
  const wantsAdmin = hasAdminClaim(info, policy);

  let user = db.select().from(schema.users).where(eq(schema.users.ssoSub, sub)).all()[0];
  if (!user && email) {
    user = db.select().from(schema.users).where(eq(schema.users.email, email)).all()[0];
    if (user) {
      db.update(schema.users).set({ ssoSub: sub }).where(eq(schema.users.id, user.id)).run();
    }
  }

  if (!user) {
    if (!policy.autoCreate) {
      throw new AppError('SSO_DENIED', 'no account exists for this identity', 401);
    }
    const id = randomUUID();
    const login = uniqueLogin(
      sanitizeLogin(preferredUsername ?? name ?? email?.split('@')[0] ?? sub),
    );
    db.insert(schema.users)
      .values({
        id,
        login,
        email,
        displayName: name,
        passHash: null,
        role: wantsAdmin ? 'admin' : 'user',
        ssoSub: sub,
        roleManaged: false,
        createdAt: nowSeconds(),
      })
      .run();
    return {
      user: db.select().from(schema.users).where(eq(schema.users.id, id)).all()[0],
      created: true,
    };
  }

  return { user: syncRole(user, wantsAdmin), created: false };
}
