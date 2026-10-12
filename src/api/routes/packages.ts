import { FastifyPluginAsync } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { config } from '../../config.js';
import { nowSeconds } from '../../lib/time.js';
import { repoEnvDir } from '../../lib/paths.js';
import * as pacman from '../../formats/pacman.js';
import { enqueueRebuild } from '../../jobs/queue.js';

const MAX_SIZE = 2 * 1024 * 1024 * 1024;

const packagesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.put('/:repo/:env/packages', { config: { bodyLimit: MAX_SIZE } }, async (request, reply) => {
    const { repo, env } = request.params as { repo: string; env: string };
    // :env is the env *name* (e.g. "stable"), not its UUID
    const envRow = db
      .select()
      .from(schema.envs)
      .where(and(eq(schema.envs.repoId, repo), eq(schema.envs.name, env)))
      .all()[0];
    if (!envRow) throw new AppError('NOT_FOUND', 'env not found', 404);

    const body = request.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new AppError('BAD_REQUEST', 'empty or invalid body', 400);
    }

    const tmpDir = join(config.DATA_DIR, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, `${randomUUID()}.pkg.tar.zst`);
    writeFileSync(tmpPath, body);

    const validation = pacman.validate(tmpPath);
    if (!validation.ok) {
      unlinkSync(tmpPath);
      throw new AppError('VALIDATION_ERROR', validation.error, 400);
    }

    const meta = pacman.ingest(envRow, tmpPath, body);

    db.insert(schema.packages)
      .values({
        id: randomUUID(),
        envId: envRow.id,
        filename: meta.filename,
        version: meta.version,
        arch: meta.arch,
        size: meta.size,
        sha256: meta.sha256,
        status: 'pending',
        createdAt: nowSeconds(),
      })
      .run();

    const jobId = await enqueueRebuild(repo, envRow.id);

    reply.status(202);
    return { success: true, data: { jobId, filename: meta.filename } };
  });

  fastify.delete('/:repo/:env/packages/:filename', async (request) => {
    const { repo, env, filename } = request.params as { repo: string; env: string; filename: string };
    // :env is the env *name* (e.g. "stable"), not its UUID
    const envRow = db
      .select()
      .from(schema.envs)
      .where(and(eq(schema.envs.repoId, repo), eq(schema.envs.name, env)))
      .all()[0];
    if (!envRow) throw new AppError('NOT_FOUND', 'env not found', 404);

    const pkg = db
      .select()
      .from(schema.packages)
      .where(and(eq(schema.packages.envId, envRow.id), eq(schema.packages.filename, filename)))
      .all()[0];
    if (!pkg) throw new AppError('NOT_FOUND', 'package not found', 404);

    try {
      unlinkSync(join(repoEnvDir(repo, envRow.id), filename));
    } catch {}
    db.delete(schema.packages).where(eq(schema.packages.id, pkg.id)).run();

    const jobId = await enqueueRebuild(repo, envRow.id);
    return { success: true, data: { jobId } };
  });
};

export default packagesRoutes;
