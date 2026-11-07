import 'fastify';
import type { users } from '../db/schema.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: typeof users.$inferSelect;
  }
}
