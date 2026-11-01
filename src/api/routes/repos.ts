import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, like, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { nowSeconds } from '../../lib/time.js';
import { resolveEnv, resolveRepo } from '../../lib/repos.js';
import { ensureRepoEnvDir } from '../../lib/paths.js';
import { generateRepoKey, publicKey, repoFingerprint } from '../../gpg/index.js';
import { formats, type RepoType } from '../../formats/index.js';
import { config } from '../../config.js';

const createRepoSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  type: z.enum(['pacman', 'deb', 'rpm', 'flatpak']),
});

const reposRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/', async (request, reply) => {
    const body = createRepoSchema.parse(request.body);
    const id = randomUUID();
    const envId = randomUUID();

    const existing = db.select().from(schema.repos).where(eq(schema.repos.name, body.name)).all();
    if (existing.length > 0) {
      throw new AppError('CONFLICT', 'repo name already exists', 409);
    }

    db.insert(schema.repos)
      .values({ id, name: body.name, type: body.type, createdAt: nowSeconds() })
      .run();
    db.insert(schema.envs).values({ id: envId, repoId: id, name: 'stable' }).run();
    ensureRepoEnvDir(id, envId);
    generateRepoKey(id);

    reply.status(201);
    return {
      success: true,
      data: { id, name: body.name, type: body.type, envs: [{ id: envId, name: 'stable' }] },
    };
  });

  fastify.get('/', async () => {
    const rows = db.select().from(schema.repos).all();
    return {
      success: true,
      data: rows.map((row) => ({ ...row, createdAt: row.createdAt * 1000 })),
    };
  });

  fastify.get('/:repo', async (request) => {
    const { repo } = request.params as { repo: string };
    const row = resolveRepo(repo);
    const envs = db.select().from(schema.envs).where(eq(schema.envs.repoId, row.id)).all();
    return { success: true, data: { ...row, createdAt: row.createdAt * 1000, envs } };
  });

  fastify.get('/:repo/:env/packages', async (request) => {
    const { repo, env } = request.params as { repo: string; env: string };
    const repoRow = resolveRepo(repo);
    const envRow = resolveEnv(repoRow.id, env);

    const { q, page = '1' } = request.query as { q?: string; page?: string };
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = 50;

    let query = db.select().from(schema.packages).where(eq(schema.packages.envId, envRow.id));
    if (q) {
      query = db
        .select()
        .from(schema.packages)
        .where(and(eq(schema.packages.envId, envRow.id), like(schema.packages.filename, `%${q}%`)));
    }
    const all = query.all();
    const total = all.length;
    const data = all.slice((pageNum - 1) * pageSize, pageNum * pageSize);

    return { success: true, data, pagination: { page: pageNum, pageSize, total } };
  });

  fastify.get('/:repo/:env/gpg-public-key', async (request, reply) => {
    const { repo } = request.params as { repo: string };
    const row = resolveRepo(repo);
    const armored = publicKey(row.id);
    if (!armored) throw new AppError('NOT_FOUND', 'no gpg key for repo', 404);
    reply.type('text/plain');
    return armored;
  });

  fastify.get('/:repo/:env/setup-snippet', async (request) => {
    const { repo, env } = request.params as { repo: string; env: string };
    const row = resolveRepo(repo);
    const fingerprint = repoFingerprint(row.id);
    if (!fingerprint) throw new AppError('NOT_FOUND', 'repo has no signing key', 404);
    const baseUrl = config.BASE_URL || `http://localhost:${config.PORT}`;
    const snippet = formats[row.type as RepoType].setupSnippet(row.name, baseUrl, env, fingerprint);
    return {
      success: true,
      data: snippet,
    };
  });
};

export default reposRoutes;
