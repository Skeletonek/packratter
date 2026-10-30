import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { verifyToken } from '../../auth/tokens.js';
import { AppError } from '../../errors.js';

// Registered on the root instance instead of as an encapsulated plugin: a
// plugin's hook only covers its own context, so sibling routes would skip auth.
export function registerAuth(app: FastifyInstance) {
  app.addHook('preHandler', async (request) => {
    if (request.method === 'GET' || request.method === 'HEAD') {
      return;
    }

    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new AppError('UNAUTHORIZED', 'Missing or invalid Authorization header', 401);
    }

    const token = auth.slice(7);
    if (!token.startsWith('pkt_') || token.length < 20) {
      throw new AppError('UNAUTHORIZED', 'Invalid token format', 401);
    }

    const prefix = token.slice(4, 16);
    const rows = db.select().from(schema.tokens).where(eq(schema.tokens.prefix, prefix)).all();
    const row = rows[0];
    if (!row || !(await verifyToken(token, row.hash))) {
      throw new AppError('UNAUTHORIZED', 'Invalid token', 401);
    }

    const users = db.select().from(schema.users).where(eq(schema.users.id, row.userId)).all();
    const user = users[0];
    if (!user) {
      throw new AppError('UNAUTHORIZED', 'Invalid token', 401);
    }

    request.user = { id: user.id, login: user.login, role: user.role };
  });
}
