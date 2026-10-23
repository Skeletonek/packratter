import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, like, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { nowSeconds } from '../../lib/time.js';
import { ensureRepoEnvDir } from '../../lib/paths.js';
import { generateRepoKey, publicKey, repoFingerprint } from '../../gpg/index.js';
import { setupSnippet as pacmanSetupSnippet } from '../../formats/pacman.js';
import { setupSnippet as flatpakSetupSnippet } from '../../formats/flatpak.js';
import { config } from '../../config.js';

const createRepoSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  type: z.enum(['pacman', 'flatpak']),
});

const reposRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/', async (request, reply) => {
    const body = createRepoSchema.parse(request.body);
    if (body.type === 'flatpak' && !config.ENABLE_FLATPAK) {
      throw new AppError('NOT_IMPLEMENTED', 'Flatpak support is disabled', 400);
    }
    const id = randomUUID();
    const envId = randomUUID();

    const existing = db.select().from(schema.repos).where(eq(schema.repos.name, body.name)).all();
    if (existing.length > 0) {
      throw new AppError('CONFLICT', 'repo name already exists', 409);
    }

    db.insert(schema.repos).values({ id, name: body.name, type: body.type, createdAt: nowSeconds() }).run();
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
    return { success: true, data: rows.map((row) => ({ ...row, createdAt: row.createdAt * 1000 })) };
  });

  fastify.get('/:repo', async (request) => {
    const { repo } = request.params as { repo: string };
    const row = db.select().from(schema.repos).where(eq(schema.repos.id, repo)).all()[0];
    if (!row) throw new AppError('NOT_FOUND', 'repo not found', 404);
    const envs = db.select().from(schema.envs).where(eq(schema.envs.repoId, repo)).all();
    return { success: true, data: { ...row, createdAt: row.createdAt * 1000, envs } };
  });

  fastify.get('/:repo/:env/packages', async (request) => {
    const { repo, env } = request.params as { repo: string; env: string };
    // :env is the env *name* (e.g. "stable"), not its UUID
    const envRow = db
      .select()
      .from(schema.envs)
      .where(and(eq(schema.envs.repoId, repo), eq(schema.envs.name, env)))
      .all()[0];
    if (!envRow) throw new AppError('NOT_FOUND', 'env not found', 404);

    const { q, page = '1' } = request.query as { q?: string; page?: string };
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = 50;

    let query = db.select().from(schema.packages).where(eq(schema.packages.envId, envRow.id));
    if (q) {
      query = db.select().from(schema.packages).where(and(eq(schema.packages.envId, envRow.id), like(schema.packages.filename, `%${q}%`)));
    }
    const all = query.all();
    const total = all.length;
    const data = all.slice((pageNum - 1) * pageSize, pageNum * pageSize);

    return { success: true, data, pagination: { page: pageNum, pageSize, total } };
  });

  fastify.get('/:repo/:env/gpg-public-key', async (request, reply) => {
    const { repo } = request.params as { repo: string };
    const armored = publicKey(repo);
    if (!armored) throw new AppError('NOT_FOUND', 'no gpg key for repo', 404);
    reply.type('text/plain');
    return armored;
  });

  fastify.get('/:repo/:env/setup-snippet', async (request) => {
    const { repo, env } = request.params as { repo: string; env: string };
    const row = db.select().from(schema.repos).where(eq(schema.repos.id, repo)).all()[0];
    if (!row) throw new AppError('NOT_FOUND', 'repo not found', 404);
    const fingerprint = repoFingerprint(repo);
    if (!fingerprint) throw new AppError('NOT_FOUND', 'repo has no signing key', 404);
    const baseUrl = config.BASE_URL || `http://localhost:${config.PORT}`;
    const snippet =
      row.type === 'flatpak'
        ? flatpakSetupSnippet(row.id, row.name, baseUrl, env, fingerprint)
        : pacmanSetupSnippet(row.id, row.name, baseUrl, env, fingerprint);
    return {
      success: true,
      data: snippet,
    };
  });
};

export default reposRoutes;
