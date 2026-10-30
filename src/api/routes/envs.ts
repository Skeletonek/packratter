import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { resolveEnv, resolveRepo } from '../../lib/repos.js';
import { ensureRepoEnvDir } from '../../lib/paths.js';

const createEnvSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9-]+$/),
});

const envsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/:repo/envs', async (request, reply) => {
    const { repo } = request.params as { repo: string };
    const body = createEnvSchema.parse(request.body);
    const repoRow = resolveRepo(repo);

    const existing = db
      .select()
      .from(schema.envs)
      .where(and(eq(schema.envs.repoId, repoRow.id), eq(schema.envs.name, body.name)))
      .all();
    if (existing.length > 0) {
      throw new AppError('CONFLICT', 'env name already exists', 409);
    }

    const id = randomUUID();
    db.insert(schema.envs).values({ id, repoId: repoRow.id, name: body.name }).run();
    ensureRepoEnvDir(repoRow.id, id);

    reply.status(201);
    return { success: true, data: { id, name: body.name } };
  });

  fastify.get('/:repo/diff', async (request) => {
    const { repo } = request.params as { repo: string };
    const { from, to } = request.query as { from?: string; to?: string };
    if (!from || !to) {
      throw new AppError('BAD_REQUEST', 'from and to query parameters are required', 400);
    }
    const repoRow = resolveRepo(repo);
    const fromEnv = resolveEnv(repoRow.id, from);
    const toEnv = resolveEnv(repoRow.id, to);

    const fromPkgs = db
      .select()
      .from(schema.packages)
      .where(eq(schema.packages.envId, fromEnv.id))
      .all();
    const toPkgs = db
      .select()
      .from(schema.packages)
      .where(eq(schema.packages.envId, toEnv.id))
      .all();

    const toByFilename = new Map(toPkgs.map((p) => [p.filename, p]));
    const fromByFilename = new Map(fromPkgs.map((p) => [p.filename, p]));

    return {
      success: true,
      data: {
        onlyInFrom: fromPkgs.filter((p) => !toByFilename.has(p.filename)),
        onlyInTo: toPkgs.filter((p) => !fromByFilename.has(p.filename)),
        different: fromPkgs.filter((p) => {
          const other = toByFilename.get(p.filename);
          return other !== undefined && other.sha256 !== p.sha256;
        }),
      },
    };
  });
};

export default envsRoutes;
