import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { config } from '../../config.js';
import { AppError } from '../../errors.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import { generateToken } from '../../auth/tokens.js';
import { consumeRecoveryCode, issueRecoveryCodes, parseStoredHashes } from '../../auth/recovery.js';
import { generateTotpSecret, matchTotpStep, otpauthUri, verifyTotpCode } from '../../auth/totp.js';
import {
  createPendingLogin,
  consumePendingLogin,
  peekPendingLogin,
  recordFailure,
} from '../../auth/pending.js';
import {
  authenticationOptions,
  ceremonyOrigin,
  clientChallenge,
  credentialRow,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from '../../auth/webauthn.js';
import {
  SESSION_COOKIE,
  createSession,
  deleteAllSessions,
  deleteSession,
  deleteSessionById,
  hashCookieValue,
  listSessions,
  purgeExpiredSessions,
} from '../../auth/sessions.js';
import { recordAudit } from '../../lib/audit.js';
import { nowSeconds } from '../../lib/time.js';

const loginSchema = z.object({
  login: z.string().min(1),
  password: z.string().min(1),
  remember: z.boolean().optional(),
});

const passwordOptions = z.string().min(8).max(128);
const emailSchema = z.string().trim().email('must be a valid email address').max(254);
const loginNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, 'letters, digits, ., _, - only');
const displayNameSchema = z.string().trim().max(64).nullable();
// '' clears a nullable field; undefined leaves it untouched
const clearableString = z.preprocess((v) => (v === '' ? null : v), displayNameSchema);

const changePasswordSchema = z.object({ current: z.string().min(1), next: passwordOptions });
const createKeySchema = z.object({
  /** Key lifetime in days; omitted = never expires. */
  expiresInDays: z.coerce.number().int().positive().max(3650).optional(),
});
const updateMeSchema = z.object({
  login: loginNameSchema.optional(),
  displayName: clearableString.optional(),
  email: z.preprocess((v) => (v === '' ? null : v), emailSchema.nullable()).optional(),
});
const createUserSchema = z.object({
  login: loginNameSchema,
  password: passwordOptions.optional(),
  email: emailSchema.optional(),
  displayName: displayNameSchema.optional(),
  role: z.enum(['admin', 'user']).optional(),
});
const updateUserSchema = z.object({
  login: loginNameSchema.optional(),
  email: emailSchema.optional(),
  displayName: clearableString.optional(),
  role: z.enum(['admin', 'user']).optional(),
  /** false hands the role back to SSO claim management. */
  roleManaged: z.boolean().optional(),
});

const forbidden = () => new AppError('FORBIDDEN', 'admin role required', 403);

/** Route-level gate for admin-only verbs (delete/rename/reconfigure). */
export function requireAdmin(request: FastifyRequest): void {
  if (request.user?.role !== 'admin') {
    throw forbidden();
  }
}

function adminCount(): number {
  return db.select().from(schema.users).where(eq(schema.users.role, 'admin')).all().length;
}

function generatedPassword(): string {
  return randomBytes(16).toString('base64url');
}

function publicUser(row: typeof schema.users.$inferSelect) {
  return {
    id: row.id,
    login: row.login,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    hasPassword: row.passHash !== null,
    roleManaged: row.roleManaged,
    createdAt: row.createdAt * 1000,
  };
}

const authRoutes: FastifyPluginAsync = async (fastify) => {
  const secureCookies = config.NODE_ENV === 'production';

  fastify.post('/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const rows = db.select().from(schema.users).where(eq(schema.users.login, body.login)).all();
    const user = rows[0];
    if (!user) {
      throw new AppError('UNAUTHORIZED', 'Wrong login or password', 401);
    }
    if (user.passHash === null) {
      throw new AppError(
        'UNAUTHORIZED',
        'This account has no local password; use SSO sign-in',
        401,
      );
    }
    if (!(await verifyPassword(user.passHash, body.password))) {
      throw new AppError('UNAUTHORIZED', 'Wrong login or password', 401);
    }

    // Password correct, but a second factor is enrolled: hand the caller a
    // short-lived pending token and the list of usable factors.
    const methods: string[] = [];
    if (user.totpEnabled) methods.push('totp');
    const hasKeys =
      db
        .select()
        .from(schema.webauthnCredentials)
        .where(eq(schema.webauthnCredentials.userId, user.id))
        .all().length > 0;
    if (hasKeys) methods.push('webauthn');
    if (methods.length > 0) {
      const pendingToken = createPendingLogin(user.id, methods);
      reply.status(401);
      return {
        success: false,
        error: { code: '2FA_REQUIRED', message: 'Second factor required', methods, pendingToken },
      };
    }

    const session = createSession(user.id, body.remember === true, request.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, session.cookieValue, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      ...(session.maxAge === undefined ? {} : { maxAge: session.maxAge }),
    });
    return { success: true, data: { login: user.login, role: user.role, email: user.email } };
  });

  const finishLoginSchema = z.object({
    pendingToken: z.string().min(1),
    remember: z.boolean().optional(),
  });
  const totpLoginSchema = finishLoginSchema.extend({ code: z.string().min(1) });

  function completeLogin(
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    remember: boolean,
  ) {
    const session = createSession(userId, remember, request.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, session.cookieValue, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      ...(session.maxAge === undefined ? {} : { maxAge: session.maxAge }),
    });
  }

  async function loadPendingUser(pendingToken: string) {
    const pending = peekPendingLogin(pendingToken);
    if (!pending) {
      throw new AppError('UNAUTHORIZED', 'Login expired, start again', 401);
    }
    const rows = db.select().from(schema.users).where(eq(schema.users.id, pending.userId)).all();
    const user = rows[0];
    if (!user) {
      throw new AppError('UNAUTHORIZED', 'Login expired, start again', 401);
    }
    return { pending, user };
  }

  fastify.post('/auth/login/totp', async (request, reply) => {
    const body = totpLoginSchema.parse(request.body);
    const { pending, user } = await loadPendingUser(body.pendingToken);
    if (!pending.methods.includes('totp')) {
      throw new AppError('UNAUTHORIZED', 'Second factor required', 401);
    }

    const matchedStep =
      user.totpEnabled && user.totpSecret !== null
        ? matchTotpStep(user.totpSecret, body.code)
        : null;
    // A code proves freshness once: reject replays of a step already spent.
    const validTotp = matchedStep !== null && matchedStep > user.totpLastUsedStep;
    if (validTotp) {
      db.update(schema.users)
        .set({ totpLastUsedStep: matchedStep })
        .where(eq(schema.users.id, user.id))
        .run();
    }
    let validRecovery = false;
    if (!validTotp) {
      const { remaining, matched } = consumeRecoveryCode(user.totpRecoveryCodes, body.code);
      if (matched) {
        validRecovery = true;
        db.update(schema.users)
          .set({ totpRecoveryCodes: JSON.stringify(remaining) })
          .where(eq(schema.users.id, user.id))
          .run();
      }
    }
    if (!validTotp && !validRecovery) {
      // Wrong guesses burn the pending token after a few tries.
      recordFailure(body.pendingToken);
      throw new AppError('UNAUTHORIZED', 'Wrong authentication code', 401);
    }

    consumePendingLogin(body.pendingToken);
    completeLogin(request, reply, user.id, body.remember === true);
    return { success: true, data: { login: user.login, role: user.role, email: user.email } };
  });

  // WebAuthn challenges are short-lived and single-purpose; a restart that
  // loses them just makes the user retry. Each entry is bound to one ceremony
  // kind so a registration challenge can never complete a login.
  interface BoundChallenge {
    kind: 'login' | 'register';
    userId: string;
    pendingToken: string;
    expiresAt: number;
  }
  const challenges = new Map<string, BoundChallenge>();

  function takeChallenge(challenge: string): BoundChallenge | null {
    for (const [key, entry] of challenges) {
      if (entry.expiresAt <= Date.now()) challenges.delete(key);
    }
    const entry = challenges.get(challenge);
    if (!entry) return null;
    challenges.delete(challenge);
    return entry;
  }

  fastify.post('/auth/login/webauthn/start', async (request) => {
    const body = finishLoginSchema.parse(request.body);
    const { pending, user } = await loadPendingUser(body.pendingToken);
    if (!pending.methods.includes('webauthn')) {
      throw new AppError('UNAUTHORIZED', 'Second factor required', 401);
    }
    const rows = db
      .select()
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.userId, user.id))
      .all();
    const options = await authenticationOptions(
      rows.map((row) => row.id),
      ceremonyOrigin(request),
    );
    challenges.set(options.challenge, {
      kind: 'login',
      userId: user.id,
      pendingToken: body.pendingToken,
      expiresAt: Date.now() + 5 * 60_000,
    });
    return { success: true, data: options };
  });

  fastify.post('/auth/login/webauthn/finish', async (request, reply) => {
    const body = z
      .object({
        pendingToken: z.string().min(1),
        remember: z.boolean().optional(),
        credentialId: z.string().min(1),
        response: z.any(),
      })
      .parse(request.body);
    const { pending, user } = await loadPendingUser(body.pendingToken);
    if (!pending.methods.includes('webauthn')) {
      throw new AppError('UNAUTHORIZED', 'Second factor required', 401);
    }
    const row = credentialRow(user.id, body.credentialId);
    if (!row) {
      throw new AppError('UNAUTHORIZED', 'Unknown security key', 401);
    }
    const assertion = body.response as Parameters<typeof verifyAuthentication>[1];
    const challenge = clientChallenge(assertion);
    const bound = challenge ? takeChallenge(challenge) : null;
    if (
      !bound ||
      bound.kind !== 'login' ||
      bound.userId !== user.id ||
      bound.pendingToken !== body.pendingToken
    ) {
      throw new AppError('UNAUTHORIZED', 'Login expired, start again', 401);
    }
    let newCounter: number;
    try {
      ({ newCounter } = await verifyAuthentication(
        row.id,
        assertion,
        challenge!,
        ceremonyOrigin(request),
      ));
    } catch {
      throw new AppError('UNAUTHORIZED', 'Security key verification failed', 401);
    }
    db.update(schema.webauthnCredentials)
      .set({ counter: newCounter, lastUsedAt: nowSeconds() })
      .where(eq(schema.webauthnCredentials.id, row.id))
      .run();

    consumePendingLogin(body.pendingToken);
    completeLogin(request, reply, user.id, body.remember === true);
    return { success: true, data: { login: user.login, role: user.role, email: user.email } };
  });

  fastify.post('/auth/logout', async (request, reply) => {
    const cookieValue = (request.cookies as Record<string, string>)[SESSION_COOKIE];
    if (cookieValue) {
      deleteSession(cookieValue);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { success: true };
  });

  // Rows are keyed by the sha256 of the cookie value; that hash doubles as the
  // opaque id used to revoke one session from the list.
  function currentSessionId(request: FastifyRequest): string | null {
    const cookieValue = (request.cookies as Record<string, string>)[SESSION_COOKIE];
    return cookieValue ? hashCookieValue(cookieValue) : null;
  }

  fastify.get('/sessions', async (request) => {
    const current = currentSessionId(request);
    return {
      success: true,
      data: listSessions(request.user!.id).map((row) => ({
        id: row.id,
        createdAt: row.createdAt * 1000,
        expiresAt: row.expiresAt * 1000,
        userAgent: row.userAgent,
        current: row.id === current,
      })),
    };
  });

  fastify.delete('/sessions/:id', async (request) => {
    const { id } = request.params as { id: string };
    if (!deleteSessionById(id, request.user!.id)) {
      throw new AppError('NOT_FOUND', 'session not found', 404);
    }
    return { success: true };
  });

  fastify.post('/sessions/revoke-all', async (request, reply) => {
    deleteAllSessions(request.user!.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { success: true };
  });

  fastify.get('/me', async (request) => {
    const rows = db.select().from(schema.users).where(eq(schema.users.id, request.user!.id)).all();
    return { success: true, data: publicUser(rows[0]) };
  });

  fastify.patch('/me', async (request) => {
    const body = updateMeSchema.parse(request.body);
    const me = request.user!;

    const patch: Partial<typeof schema.users.$inferInsert> = {};
    if (body.login !== undefined && body.login !== me.login) {
      const clash = db.select().from(schema.users).where(eq(schema.users.login, body.login)).all();
      if (clash.length > 0) {
        throw new AppError('CONFLICT', 'login already exists', 409);
      }
      patch.login = body.login;
    }
    if (body.email !== undefined) {
      patch.email = body.email;
    }
    if (body.displayName !== undefined) {
      patch.displayName = body.displayName;
    }

    if (Object.keys(patch).length > 0) {
      db.update(schema.users).set(patch).where(eq(schema.users.id, me.id)).run();
    }
    const updated = db.select().from(schema.users).where(eq(schema.users.id, me.id)).all()[0];
    return { success: true, data: publicUser(updated) };
  });

  fastify.post('/me/password', async (request) => {
    const body = changePasswordSchema.parse(request.body);
    const rows = db.select().from(schema.users).where(eq(schema.users.id, request.user!.id)).all();
    const user = rows[0];
    if (!user || user.passHash === null) {
      // SSO-only accounts have nothing to verify a current password against;
      // an admin can grant one via the user management page.
      throw new AppError('BAD_REQUEST', 'this account has no local password', 400);
    }
    if (!(await verifyPassword(user.passHash, body.current))) {
      throw new AppError('INVALID_CREDENTIAL', 'Wrong current password', 401);
    }
    db.update(schema.users)
      .set({ passHash: await hashPassword(body.next) })
      .where(eq(schema.users.id, user.id))
      .run();
    recordAudit(request, 'user.password_change', {
      type: 'user',
      id: user.id,
      label: user.login,
    });
    return { success: true };
  });

  // --- two-factor management ---

  fastify.get('/me/2fa', async (request) => {
    const user = request.user!;
    const keys = db
      .select()
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.userId, user.id))
      .all();
    return {
      success: true,
      data: {
        totpEnabled: user.totpEnabled,
        // confirmed but not yet activated: codes issued, awaiting the user's
        // "I saved my recovery codes" confirmation
        totpPending:
          !user.totpEnabled && user.totpSecret !== null && user.totpRecoveryCodes !== null,
        webauthnKeys: keys.map((row) => ({
          id: row.id,
          label: row.label,
          createdAt: row.createdAt * 1000,
          lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt * 1000,
        })),
        // a factor is worth showing only while at least one backup exists
        recoveryCodesLeft: parseStoredHashes(user.totpRecoveryCodes).length,
      },
    };
  });

  const totpConfirmSchema = z.object({ code: z.string().min(6).max(10) });

  /**
   * Factor enrollment and removal must not ride on a possibly-stolen session
   * alone. Accounts with a local password re-prove it; SSO-only accounts have
   * no local credential (and their factors gate no local login), so their
   * session stands.
   */
  async function assertFreshPassword(
    user: typeof schema.users.$inferSelect,
    password: string | undefined,
  ): Promise<void> {
    if (user.passHash === null) return;
    // INVALID_CREDENTIAL, not UNAUTHORIZED: a wrong password here must show an
    // error in place, not be mistaken for session expiry (which logs the user out).
    if (password === undefined) {
      throw new AppError('INVALID_CREDENTIAL', 'Password confirmation required', 401);
    }
    if (!(await verifyPassword(user.passHash, password))) {
      throw new AppError('INVALID_CREDENTIAL', 'Wrong password', 401);
    }
  }

  fastify.post('/me/2fa/totp/setup', async (request) => {
    const body = z.object({ password: z.string().min(1).optional() }).parse(request.body ?? {});
    const me = request.user!;
    const rows = db.select().from(schema.users).where(eq(schema.users.id, me.id)).all();
    const user = rows[0];
    if (user.totpEnabled) {
      throw new AppError('CONFLICT', 'TOTP is already enabled', 409);
    }
    await assertFreshPassword(user, body.password);
    const secret = generateTotpSecret();
    db.update(schema.users).set({ totpSecret: secret }).where(eq(schema.users.id, user.id)).run();
    return {
      success: true,
      data: { secret, otpauthUri: otpauthUri(secret, user.login) },
    };
  });

  fastify.post('/me/2fa/totp/confirm', async (request) => {
    const body = totpConfirmSchema.parse(request.body);
    const me = request.user!;
    const rows = db.select().from(schema.users).where(eq(schema.users.id, me.id)).all();
    const user = rows[0];
    if (user.totpSecret === null) {
      throw new AppError('BAD_REQUEST', 'start TOTP setup first', 400);
    }
    const step = user.totpSecret === null ? null : matchTotpStep(user.totpSecret, body.code);
    if (step === null) {
      throw new AppError('INVALID_CREDENTIAL', 'Wrong authentication code', 401);
    }
    // Codes are issued here but TOTP stays off until the user confirms the
    // codes are saved — enrollment must never outlive a lost backup.
    const { codes, stored } = issueRecoveryCodes();
    db.update(schema.users)
      .set({ totpRecoveryCodes: stored, totpLastUsedStep: step })
      .where(eq(schema.users.id, user.id))
      .run();
    // Recovery codes are shown exactly once, at enrollment.
    return { success: true, data: { recoveryCodes: codes } };
  });

  fastify.post('/me/2fa/totp/activate', async (request) => {
    const me = request.user!;
    const rows = db.select().from(schema.users).where(eq(schema.users.id, me.id)).all();
    const user = rows[0];
    if (user.totpEnabled) {
      throw new AppError('CONFLICT', 'TOTP is already enabled', 409);
    }
    if (user.totpSecret === null || user.totpRecoveryCodes === null) {
      throw new AppError(
        'BAD_REQUEST',
        'confirm the authenticator and save recovery codes first',
        400,
      );
    }
    db.update(schema.users).set({ totpEnabled: true }).where(eq(schema.users.id, user.id)).run();
    recordAudit(
      request,
      'user.2fa_enroll',
      { type: 'user', id: user.id, label: user.login },
      {
        factor: 'totp',
      },
    );
    return { success: true };
  });

  const totpDisableSchema = z.object({
    code: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
  });

  fastify.post('/me/2fa/totp/disable', async (request) => {
    const body = totpDisableSchema.parse(request.body ?? {});
    const me = request.user!;
    const rows = db.select().from(schema.users).where(eq(schema.users.id, me.id)).all();
    const user = rows[0];
    if (!user.totpEnabled) {
      throw new AppError('BAD_REQUEST', 'TOTP is not enabled', 400);
    }
    // Disabling a factor needs proof of the account: the factor itself or the
    // password (for a user who lost the authenticator but still has access).
    const byCode =
      user.totpSecret !== null && body.code !== undefined
        ? verifyTotpCode(user.totpSecret, body.code)
        : false;
    const byRecovery =
      !byCode && body.code !== undefined
        ? consumeRecoveryCode(user.totpRecoveryCodes, body.code).matched
        : false;
    const byPassword =
      !byCode &&
      !byRecovery &&
      body.password !== undefined &&
      user.passHash !== null &&
      (await verifyPassword(user.passHash, body.password));
    if (!byCode && !byRecovery && !byPassword) {
      throw new AppError('INVALID_CREDENTIAL', 'Wrong authentication code or password', 401);
    }
    db.update(schema.users)
      .set({ totpSecret: null, totpEnabled: false, totpRecoveryCodes: null })
      .where(eq(schema.users.id, user.id))
      .run();
    recordAudit(
      request,
      'user.2fa_remove',
      { type: 'user', id: user.id, label: user.login },
      {
        factor: 'totp',
      },
    );
    return { success: true };
  });

  fastify.post('/me/2fa/totp/recovery-codes', async (request) => {
    const body = totpConfirmSchema
      .extend({ password: z.string().min(1).optional() })
      .parse(request.body);
    const me = request.user!;
    const rows = db.select().from(schema.users).where(eq(schema.users.id, me.id)).all();
    const user = rows[0];
    if (!user.totpEnabled) {
      throw new AppError('BAD_REQUEST', 'TOTP is not enabled', 400);
    }
    const byCode = user.totpSecret !== null && verifyTotpCode(user.totpSecret, body.code);
    const byPassword =
      !byCode &&
      body.password !== undefined &&
      user.passHash !== null &&
      (await verifyPassword(user.passHash, body.password));
    if (!byCode && !byPassword) {
      throw new AppError('INVALID_CREDENTIAL', 'Wrong authentication code or password', 401);
    }
    const { codes, stored } = issueRecoveryCodes();
    db.update(schema.users)
      .set({ totpRecoveryCodes: stored })
      .where(eq(schema.users.id, user.id))
      .run();
    return { success: true, data: { recoveryCodes: codes } };
  });

  // --- webauthn key management ---

  fastify.post('/me/2fa/webauthn/register/start', async (request) => {
    const user = request.user!;
    const options = await registrationOptions(user.id, user.login, ceremonyOrigin(request));
    challenges.set(options.challenge, {
      kind: 'register',
      userId: user.id,
      pendingToken: '',
      expiresAt: Date.now() + 5 * 60_000,
    });
    return { success: true, data: options };
  });

  const registerFinishSchema = z.object({
    label: z.string().trim().min(1).max(64).optional(),
    password: z.string().min(1).optional(),
    response: z.any(),
  });

  fastify.post('/me/2fa/webauthn/register/finish', async (request, reply) => {
    const body = registerFinishSchema.parse(request.body);
    const me = request.user!;
    const rows = db.select().from(schema.users).where(eq(schema.users.id, me.id)).all();
    const user = rows[0];
    await assertFreshPassword(user, body.password);
    const registration = body.response as Parameters<typeof verifyRegistration>[0];
    const challenge = clientChallenge(registration);
    const bound = challenge ? takeChallenge(challenge) : null;
    if (!bound || bound.kind !== 'register' || bound.userId !== user.id) {
      throw new AppError('BAD_REQUEST', 'Registration expired, start again', 400);
    }
    let result: Awaited<ReturnType<typeof verifyRegistration>>;
    try {
      result = await verifyRegistration(registration, challenge!, ceremonyOrigin(request));
    } catch {
      throw new AppError('INVALID_CREDENTIAL', 'Security key registration failed', 401);
    }
    db.insert(schema.webauthnCredentials)
      .values({
        id: result.credentialId,
        userId: user.id,
        publicKey: result.publicKey,
        counter: result.counter,
        transports: result.transports ? JSON.stringify(result.transports) : null,
        label: body.label ?? 'Security key',
        createdAt: nowSeconds(),
      })
      .run();
    recordAudit(
      request,
      'user.webauthn_enroll',
      { type: 'user', id: user.id, label: user.login },
      {
        credentialLabel: body.label ?? 'Security key',
      },
    );
    reply.status(201);
    return {
      success: true,
      data: { id: result.credentialId, label: body.label ?? 'Security key' },
    };
  });

  fastify.delete('/me/2fa/webauthn/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({ password: z.string().min(1).optional() }).parse(request.body ?? {});
    const me = request.user!;
    const rows = db.select().from(schema.users).where(eq(schema.users.id, me.id)).all();
    const user = rows[0];
    await assertFreshPassword(user, body.password);
    const row = credentialRow(user.id, id);
    if (!row) {
      throw new AppError('NOT_FOUND', 'security key not found', 404);
    }
    // No lockout guard: security keys are second factors only. Removing the
    // last one falls back to password (or SSO) sign-in, which stays usable.
    db.delete(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.id, id)).run();
    recordAudit(
      request,
      'user.webauthn_remove',
      { type: 'user', id: user.id, label: user.login },
      {
        credentialLabel: row.label,
      },
    );
    return { success: true };
  });

  fastify.get('/keys', async (request) => {
    const rows = db
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.userId, request.user!.id))
      .all();
    return {
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        prefix: row.prefix,
        createdAt: row.createdAt * 1000,
        expiresAt: row.expiresAt === null ? null : row.expiresAt * 1000,
        lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt * 1000,
      })),
    };
  });

  fastify.post('/keys', async (request, reply) => {
    const body = createKeySchema.parse(request.body ?? {});
    const { token, prefix, hash } = await generateToken();
    const id = randomUUID();
    const expiresAt = body.expiresInDays ? nowSeconds() + body.expiresInDays * 86400 : null;
    db.insert(schema.tokens)
      .values({
        id,
        userId: request.user!.id,
        prefix,
        hash,
        scopes: 'admin',
        createdAt: nowSeconds(),
        expiresAt,
      })
      .run();
    reply.status(201);
    // The plaintext token exists only in this response and in the caller's hand.
    recordAudit(
      request,
      'token.create',
      { type: 'token', id, label: prefix },
      { login: request.user!.login, expiresInDays: body.expiresInDays ?? null },
    );
    return {
      success: true,
      data: { id, prefix, token, expiresAt: expiresAt === null ? null : expiresAt * 1000 },
    };
  });

  fastify.delete('/keys/:id', async (request) => {
    const { id } = request.params as { id: string };
    const rows = db.select().from(schema.tokens).where(eq(schema.tokens.id, id)).all();
    const row = rows[0];
    if (!row || row.userId !== request.user!.id) {
      throw new AppError('NOT_FOUND', 'key not found', 404);
    }
    db.delete(schema.tokens).where(eq(schema.tokens.id, id)).run();
    recordAudit(request, 'token.revoke', { type: 'token', id, label: row.prefix });
    return { success: true };
  });

  fastify.get('/users', async (request) => {
    requireAdmin(request);
    const rows = db.select().from(schema.users).all();
    return { success: true, data: rows.map(publicUser) };
  });

  fastify.post('/users', async (request, reply) => {
    requireAdmin(request);
    const body = createUserSchema.parse(request.body);
    const exists = db.select().from(schema.users).where(eq(schema.users.login, body.login)).all();
    if (exists.length > 0) {
      throw new AppError('CONFLICT', 'login already exists', 409);
    }

    const id = randomUUID();
    const password = body.password ?? generatedPassword();
    db.insert(schema.users)
      .values({
        id,
        login: body.login,
        email: body.email ?? null,
        displayName: body.displayName ?? null,
        passHash: await hashPassword(password),
        role: body.role ?? 'user',
        createdAt: nowSeconds(),
      })
      .run();

    reply.status(201);
    // Same one-time contract as the bootstrap superuser password.
    recordAudit(
      request,
      'user.create',
      { type: 'user', id, label: body.login },
      { role: body.role ?? 'user' },
    );
    return {
      success: true,
      data: { id, login: body.login, role: body.role ?? 'user', password },
    };
  });

  fastify.patch('/users/:id', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const body = updateUserSchema.parse(request.body);
    const rows = db.select().from(schema.users).where(eq(schema.users.id, id)).all();
    const target = rows[0];
    if (!target) {
      throw new AppError('NOT_FOUND', 'user not found', 404);
    }

    const patch: Partial<typeof schema.users.$inferInsert> = {};
    if (body.login !== undefined && body.login !== target.login) {
      const clash = db.select().from(schema.users).where(eq(schema.users.login, body.login)).all();
      if (clash.length > 0) {
        throw new AppError('CONFLICT', 'login already exists', 409);
      }
      patch.login = body.login;
    }
    if (body.email !== undefined) {
      patch.email = body.email;
    }
    if (body.displayName !== undefined) {
      patch.displayName = body.displayName;
    }
    if (body.role !== undefined && body.role !== target.role) {
      if (target.role === 'admin' && adminCount() === 1) {
        throw new AppError('CONFLICT', 'cannot demote the last admin', 409);
      }
      patch.role = body.role;
      // A hand-edited role belongs to the admin from now on: the SSO claim
      // must never silently overwrite it on the user's next sign-in.
      patch.roleManaged = true;
    }
    if (body.roleManaged !== undefined) {
      patch.roleManaged = body.roleManaged;
    }

    if (Object.keys(patch).length > 0) {
      db.update(schema.users).set(patch).where(eq(schema.users.id, id)).run();
      recordAudit(request, 'user.update', { type: 'user', id, label: target.login }, patch);
    }
    return { success: true };
  });

  fastify.post('/users/:id/password', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const rows = db.select().from(schema.users).where(eq(schema.users.id, id)).all();
    const target = rows[0];
    if (!target) {
      throw new AppError('NOT_FOUND', 'user not found', 404);
    }

    const password = generatedPassword();
    db.update(schema.users)
      .set({
        passHash: await hashPassword(password),
        // A forced reset takes over the account: second factors go with it, or
        // a locked-out user could never get back in past their own TOTP.
        totpSecret: null,
        totpEnabled: false,
        totpRecoveryCodes: null,
      })
      .where(eq(schema.users.id, id))
      .run();
    db.delete(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.userId, id)).run();

    // A forced reset means the caller is taking over the account: existing
    // devices must not survive it. (Own password changes intentionally do.)
    db.delete(schema.sessions).where(eq(schema.sessions.userId, id)).run();

    // Same one-time contract as account creation and the bootstrap password.
    recordAudit(request, 'user.password_reset', { type: 'user', id, label: target.login });
    return { success: true, data: { id, login: target.login, password } };
  });

  fastify.delete('/users/:id', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    if (request.user!.id === id) {
      throw new AppError('CONFLICT', 'cannot delete yourself', 409);
    }
    const rows = db.select().from(schema.users).where(eq(schema.users.id, id)).all();
    const target = rows[0];
    if (!target) {
      throw new AppError('NOT_FOUND', 'user not found', 404);
    }
    if (target.role === 'admin' && adminCount() === 1) {
      throw new AppError('CONFLICT', 'cannot delete the last admin', 409);
    }

    purgeExpiredSessions();
    db.delete(schema.users).where(eq(schema.users.id, id)).run();
    recordAudit(request, 'user.delete', { type: 'user', id, label: target.login });
    return { success: true };
  });
};

export default authRoutes;
