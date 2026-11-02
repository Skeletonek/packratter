import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, inArray, like, and, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { nowSeconds } from '../../lib/time.js';
import { resolveEnv, resolveRepo } from '../../lib/repos.js';
import { assertTypeAvailable, scanToolchain } from '../../lib/toolchain.js';
import { ensureRepoEnvDir } from '../../lib/paths.js';
import { generateRepoKey, repoFingerprint, gpgHome } from '../../gpg/index.js';
import { formats, type RepoType } from '../../formats/index.js';
import { sortPackages } from '../../lib/packageSort.js';
import { config } from '../../config.js';
import { requireAdmin } from './auth.js';
import { repoRole, requireRepoRole, visibleRepoIds } from '../../auth/access.js';

/** Refuse destructive verbs while queued/running jobs may still write files. */
export function guardNoRunningJobs(repoId: string, subject: string): void {
  const busy = db
    .select()
    .from(schema.jobs)
    .where(
      and(eq(schema.jobs.repoId, repoId), sql`${schema.jobs.status} in ('pending', 'running')`),
    )
    .all();
  if (busy.length > 0) {
    throw new AppError(
      'REPO_BUSY',
      `cannot delete the ${subject} while its rebuild jobs are pending or running`,
      409,
    );
  }
}

const createRepoSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  type: z.enum(['pacman', 'deb', 'rpm', 'flatpak']),
  env: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
});

const patchRepoSchema = z.object({
  branchMode: z.enum(['env', 'bundle']),
});

const memberSchema = z.object({
  login: z.string().min(1).max(64),
  role: z.enum(['maintainer', 'viewer']),
});

const patchMemberSchema = z.object({
  role: z.enum(['maintainer', 'viewer']),
});

const reposRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/', async (request, reply) => {
    requireAdmin(request);
    const body = createRepoSchema.parse(request.body);
    const id = randomUUID();
    const envId = randomUUID();

    const existing = db.select().from(schema.repos).where(eq(schema.repos.name, body.name)).all();
    if (existing.length > 0) {
      throw new AppError('CONFLICT', 'repo name already exists', 409);
    }

    assertTypeAvailable(body.type, await scanToolchain());

    const envName = body.env ?? 'stable';
    db.insert(schema.repos)
      .values({ id, name: body.name, type: body.type, createdAt: nowSeconds() })
      .run();
    db.insert(schema.envs).values({ id: envId, repoId: id, name: envName }).run();
    ensureRepoEnvDir(id, envId);
    generateRepoKey(id);

    reply.status(201);
    return {
      success: true,
      data: { id, name: body.name, type: body.type, envs: [{ id: envId, name: envName }] },
    };
  });

  fastify.get('/', async (request) => {
    const allowed = visibleRepoIds(request.user!);
    const rows =
      allowed === null
        ? db.select().from(schema.repos).all()
        : allowed.length === 0
          ? []
          : db.select().from(schema.repos).where(inArray(schema.repos.id, allowed)).all();
    const envs = db.select().from(schema.envs).all();
    const counts = db
      .select({ envId: schema.packages.envId, count: sql<number>`count(*)` })
      .from(schema.packages)
      .groupBy(schema.packages.envId)
      .all();
    const envIdsByRepo = new Map<string, { id: string; name: string }[]>();
    for (const env of envs) {
      const list = envIdsByRepo.get(env.repoId) ?? [];
      list.push({ id: env.id, name: env.name });
      envIdsByRepo.set(env.repoId, list);
    }
    const countByEnvId = new Map(counts.map((c) => [c.envId, c.count]));

    return {
      success: true,
      data: rows.map((row) => {
        const envList = envIdsByRepo.get(row.id) ?? [];
        return {
          ...row,
          createdAt: row.createdAt * 1000,
          envs: envList,
          packageCount: envList.reduce((sum, env) => sum + (countByEnvId.get(env.id) ?? 0), 0),
        };
      }),
    };
  });

  fastify.delete('/:repo', async (request) => {
    requireAdmin(request);
    const { repo } = request.params as { repo: string };
    const repoRow = resolveRepo(repo);
    guardNoRunningJobs(repoRow.id, 'repository');

    // DB first (cascades envs/packages, nulls job refs); disk cleanup after.
    db.delete(schema.repos).where(eq(schema.repos.id, repoRow.id)).run();

    const envDir = join(config.DATA_DIR, 'repos', repoRow.id);
    rmSync(envDir, { recursive: true, force: true });
    rmSync(gpgHome(repoRow.id), { recursive: true, force: true });

    return { success: true };
  });

  fastify.get('/:repo', async (request) => {
    const { repo } = request.params as { repo: string };
    const row = resolveRepo(repo);
    requireRepoRole(request.user!, row.id, 'viewer');
    const envs = db.select().from(schema.envs).where(eq(schema.envs.repoId, row.id)).all();
    return {
      success: true,
      data: {
        ...row,
        createdAt: row.createdAt * 1000,
        envs,
        // the caller's effective role decides which settings the UI shows
        yourRole: repoRole(request.user!, row.id),
      },
    };
  });

  fastify.patch('/:repo', async (request) => {
    requireAdmin(request);
    const { repo } = request.params as { repo: string };
    const body = patchRepoSchema.parse(request.body);
    const row = resolveRepo(repo);
    if (row.type !== 'flatpak') {
      throw new AppError('BAD_REQUEST', 'branch naming only applies to flatpak repositories', 400);
    }
    db.update(schema.repos)
      .set({ branchMode: body.branchMode })
      .where(eq(schema.repos.id, row.id))
      .run();
    return { success: true, data: { branchMode: body.branchMode } };
  });

  fastify.get('/:repo/:env/packages', async (request) => {
    const { repo, env } = request.params as { repo: string; env: string };
    const repoRow = resolveRepo(repo);
    requireRepoRole(request.user!, repoRow.id, 'viewer');
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
    const sorted = sortPackages(all, repoRow.type as RepoType);
    const data = sorted.slice((pageNum - 1) * pageSize, pageNum * pageSize);

    return { success: true, data, pagination: { page: pageNum, pageSize, total } };
  });

  fastify.get('/:repo/:env/setup-snippet', async (request) => {
    const { repo, env } = request.params as { repo: string; env: string };
    const row = resolveRepo(repo);
    requireRepoRole(request.user!, row.id, 'viewer');
    const fingerprint = repoFingerprint(row.id);
    if (!fingerprint) throw new AppError('NOT_FOUND', 'repo has no signing key', 404);
    const baseUrl = config.BASE_URL || `http://localhost:${config.PORT}`;
    const snippet = formats[row.type as RepoType].setupSnippet(row.name, baseUrl, env, fingerprint);
    return {
      success: true,
      data: snippet,
    };
  });

  fastify.get('/:repo/members', async (request) => {
    requireAdmin(request);
    const { repo } = request.params as { repo: string };
    const row = resolveRepo(repo);
    return { success: true, data: listMembers(row.id) };
  });

  fastify.post('/:repo/members', async (request, reply) => {
    requireAdmin(request);
    const { repo } = request.params as { repo: string };
    const body = memberSchema.parse(request.body);
    const row = resolveRepo(repo);
    const user = userByLogin(body.login);
    const existing = memberRow(row.id, user.id);
    if (existing) {
      throw new AppError('CONFLICT', 'user already has access to this repository', 409);
    }
    db.insert(schema.repoMembers)
      .values({ repoId: row.id, userId: user.id, role: body.role })
      .run();
    reply.status(201);
    return { success: true, data: { login: user.login, role: body.role } };
  });

  fastify.patch('/:repo/members/:login', async (request) => {
    requireAdmin(request);
    const { repo, login } = request.params as { repo: string; login: string };
    const body = patchMemberSchema.parse(request.body);
    const row = resolveRepo(repo);
    const user = userByLogin(login);
    if (!memberRow(row.id, user.id)) {
      throw new AppError('NOT_FOUND', 'member not found', 404);
    }
    db.update(schema.repoMembers)
      .set({ role: body.role })
      .where(and(eq(schema.repoMembers.repoId, row.id), eq(schema.repoMembers.userId, user.id)))
      .run();
    return { success: true, data: { login: user.login, role: body.role } };
  });

  fastify.delete('/:repo/members/:login', async (request) => {
    requireAdmin(request);
    const { repo, login } = request.params as { repo: string; login: string };
    const row = resolveRepo(repo);
    const user = userByLogin(login);
    if (!memberRow(row.id, user.id)) {
      throw new AppError('NOT_FOUND', 'member not found', 404);
    }
    db.delete(schema.repoMembers)
      .where(and(eq(schema.repoMembers.repoId, row.id), eq(schema.repoMembers.userId, user.id)))
      .run();
    return { success: true };
  });
};

function userByLogin(login: string) {
  const user = db.select().from(schema.users).where(eq(schema.users.login, login)).all()[0];
  if (!user) throw new AppError('NOT_FOUND', 'user not found', 404);
  return user;
}

function memberRow(repoId: string, userId: string) {
  return db
    .select()
    .from(schema.repoMembers)
    .where(and(eq(schema.repoMembers.repoId, repoId), eq(schema.repoMembers.userId, userId)))
    .all()[0];
}

function listMembers(repoId: string) {
  const rows = db
    .select()
    .from(schema.repoMembers)
    .where(eq(schema.repoMembers.repoId, repoId))
    .all();
  const users = new Map(
    db
      .select()
      .from(schema.users)
      .all()
      .map((u) => [u.id, u]),
  );
  return rows.map((row) => ({
    login: users.get(row.userId)?.login ?? '?',
    displayName: users.get(row.userId)?.displayName ?? null,
    role: row.role,
  }));
}

export default reposRoutes;
