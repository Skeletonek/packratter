import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { config } from '../../config.js';
import { AppError } from '../../errors.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import { generateToken } from '../../auth/tokens.js';
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  purgeExpiredSessions,
} from '../../auth/sessions.js';
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
    createdAt: row.createdAt * 1000,
  };
}

const authRoutes: FastifyPluginAsync = async (fastify) => {
  const secureCookies = config.NODE_ENV === 'production';

  fastify.post('/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const rows = db.select().from(schema.users).where(eq(schema.users.login, body.login)).all();
    const user = rows[0];
    if (!user || !(await verifyPassword(user.passHash, body.password))) {
      throw new AppError('UNAUTHORIZED', 'Wrong login or password', 401);
    }

    const session = createSession(user.id, body.remember === true);
    reply.setCookie(SESSION_COOKIE, session.cookieValue, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      ...(session.maxAge === undefined ? {} : { maxAge: session.maxAge }),
    });
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
    if (!user || !(await verifyPassword(user.passHash, body.current))) {
      throw new AppError('UNAUTHORIZED', 'Wrong current password', 401);
    }
    db.update(schema.users)
      .set({ passHash: await hashPassword(body.next) })
      .where(eq(schema.users.id, user.id))
      .run();
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
      })),
    };
  });

  fastify.post('/keys', async (request, reply) => {
    const { token, prefix, hash } = await generateToken();
    const id = randomUUID();
    db.insert(schema.tokens)
      .values({
        id,
        userId: request.user!.id,
        prefix,
        hash,
        scopes: 'admin',
        createdAt: nowSeconds(),
      })
      .run();
    reply.status(201);
    // The plaintext token exists only in this response and in the caller's hand.
    return { success: true, data: { id, prefix, token } };
  });

  fastify.delete('/keys/:id', async (request) => {
    const { id } = request.params as { id: string };
    const rows = db.select().from(schema.tokens).where(eq(schema.tokens.id, id)).all();
    const row = rows[0];
    if (!row || row.userId !== request.user!.id) {
      throw new AppError('NOT_FOUND', 'key not found', 404);
    }
    db.delete(schema.tokens).where(eq(schema.tokens.id, id)).run();
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
    }

    if (Object.keys(patch).length > 0) {
      db.update(schema.users).set(patch).where(eq(schema.users.id, id)).run();
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
      .set({ passHash: await hashPassword(password) })
      .where(eq(schema.users.id, id))
      .run();

    // A forced reset means the caller is taking over the account: existing
    // devices must not survive it. (Own password changes intentionally do.)
    db.delete(schema.sessions).where(eq(schema.sessions.userId, id)).run();

    // Same one-time contract as account creation and the bootstrap password.
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
    return { success: true };
  });
};

export default authRoutes;
