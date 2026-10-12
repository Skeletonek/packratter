import { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { AppError } from '../../errors.js';

const jobsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const row = db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).all()[0];
    if (!row) throw new AppError('NOT_FOUND', 'job not found', 404);
    return { success: true, data: row };
  });
};

export default jobsRoutes;
