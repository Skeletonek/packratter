import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { verifyToken } from '../../auth/tokens.js';
import { SESSION_COOKIE, sessionUserId } from '../../auth/sessions.js';
import { AppError } from '../../errors.js';

// Login and logout need to work without a valid session: logout must still be
// able to clear a too-old cookie.
const PUBLIC_API_PATHS = new Set(['/api/v1/auth/login', '/api/v1/auth/logout']);

const unauthorized = (message: string) => new AppError('UNAUTHORIZED', message, 401);

type SchemaUser = typeof schema.users.$inferSelect;

function loadUser(id: string): SchemaUser | null {
  return db.select().from(schema.users).where(eq(schema.users.id, id)).all()[0] ?? null;
}

async function resolveUser(request: FastifyRequest): Promise<SchemaUser> {
  const auth = request.headers.authorization;

  if (auth) {
    if (!auth.startsWith('Bearer ')) {
      throw unauthorized('Invalid Authorization header');
    }
    const token = auth.slice(7);
    if (!token.startsWith('pkt_') || token.length < 20) {
      throw unauthorized('Invalid token format');
    }
    const prefix = token.slice(4, 16);
    const rows = db.select().from(schema.tokens).where(eq(schema.tokens.prefix, prefix)).all();
    const row = rows[0];
    if (!row || !(await verifyToken(token, row.hash))) {
      throw unauthorized('Invalid token');
    }
    const user = loadUser(row.userId);
    if (!user) {
      throw unauthorized('Invalid token');
    }
    return user;
  }

  const cookieValue = (request.cookies as Record<string, string>)[SESSION_COOKIE];
  if (!cookieValue) {
    throw unauthorized('Not signed in');
  }
  const userId = sessionUserId(cookieValue);
  const user = userId !== null ? loadUser(userId) : null;
  if (!user) {
    throw unauthorized('Session expired, sign in again');
  }
  return user;
}

// Registered on the root instance instead of as an encapsulated plugin: a
// plugin's hook only covers its own context, so sibling routes would skip auth.
export function registerAuth(app: FastifyInstance) {
  app.addHook('preHandler', async (request) => {
    const [path] = request.url.split('?');
    if (!path.startsWith('/api/') || PUBLIC_API_PATHS.has(path)) {
      return;
    }
    request.user = await resolveUser(request);
  });
}
