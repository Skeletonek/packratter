import { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { resolveEnv, resolveRepo } from '../../lib/repos.js';
import { enqueueRebuild } from '../../jobs/queue.js';

const jobsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request) => {
    const {
      repo,
      env,
      page = '1',
    } = request.query as {
      repo?: string;
      env?: string;
      page?: string;
    };
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = 50;

    const conditions = [];
    if (repo) {
      const repoRow = resolveRepo(repo);
      conditions.push(eq(schema.jobs.repoId, repoRow.id));
      if (env) {
        conditions.push(eq(schema.jobs.envId, resolveEnv(repoRow.id, env).id));
      }
    } else if (env) {
      throw new AppError('BAD_REQUEST', 'env filter requires a repo filter', 400);
    }

    const all = db
      .select()
      .from(schema.jobs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.jobs.createdAt), desc(sql`rowid`))
      .all();
    const total = all.length;
    const data = all.slice((pageNum - 1) * pageSize, pageNum * pageSize);

    return { success: true, data, pagination: { page: pageNum, pageSize, total } };
  });

  fastify.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const row = db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).all()[0];
    if (!row) throw new AppError('NOT_FOUND', 'job not found', 404);
    return { success: true, data: row };
  });

  fastify.post('/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).all()[0];
    if (!job) throw new AppError('NOT_FOUND', 'job not found', 404);
    if (job.status === 'pending' || job.status === 'running') {
      throw new AppError('CONFLICT', 'job is not finished yet', 409);
    }
    if (!job.repoId || !job.envId) {
      throw new AppError('BAD_REQUEST', 'job is not retryable', 400);
    }
    const repoRow = db.select().from(schema.repos).where(eq(schema.repos.id, job.repoId)).all()[0];
    const envRow = db.select().from(schema.envs).where(eq(schema.envs.id, job.envId)).all()[0];
    if (!repoRow || !envRow) {
      throw new AppError('BAD_REQUEST', 'job repo or env no longer exists', 400);
    }

    const jobId = await enqueueRebuild(job.repoId, job.envId);
    reply.status(202);
    return { success: true, data: { jobId } };
  });
};

export default jobsRoutes;
