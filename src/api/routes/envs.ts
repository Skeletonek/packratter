import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { resolveEnv, resolveRepo } from '../../lib/repos.js';
import { repoEnvDir } from '../../lib/paths.js';
import { ensureRepoEnvDir } from '../../lib/paths.js';
import { formats, type RepoType } from '../../formats/index.js';
import { guardNoRunningJobs } from './repos.js';
import { requireRepoRole } from '../../auth/access.js';
import { recordAudit } from '../../lib/audit.js';
import { enqueueRebuild } from '../../jobs/queue.js';
import { sortPackages } from '../../lib/packageSort.js';

const createEnvSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9-]+$/),
});

const renameEnvSchema = createEnvSchema;

const envsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/:repo/envs', async (request, reply) => {
    const { repo } = request.params as { repo: string };
    const body = createEnvSchema.parse(request.body);
    const repoRow = resolveRepo(repo);
    requireRepoRole(request.user!, repoRow.id, 'maintainer');

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

  fastify.delete('/:repo/envs/:env', async (request) => {
    const { repo, env } = request.params as { repo: string; env: string };
    const repoRow = resolveRepo(repo);
    requireRepoRole(request.user!, repoRow.id, 'maintainer');
    const envRow = resolveEnv(repoRow.id, env);
    guardNoRunningJobs(repoRow.id, 'environment');

    const envs = db.select().from(schema.envs).where(eq(schema.envs.repoId, repoRow.id)).all();
    if (envs.length === 1) {
      throw new AppError('CONFLICT', 'cannot delete the last environment of a repository', 409);
    }

    db.delete(schema.envs).where(eq(schema.envs.id, envRow.id)).run();
    rmSync(repoEnvDir(repoRow.id, envRow.id), { recursive: true, force: true });

    recordAudit(request, 'env.delete', {
      type: 'env',
      id: envRow.id,
      label: `${repoRow.name}/${envRow.name}`,
    });
    return { success: true };
  });

  fastify.patch('/:repo/envs/:env', async (request) => {
    const { repo, env } = request.params as { repo: string; env: string };
    const body = renameEnvSchema.parse(request.body);
    const repoRow = resolveRepo(repo);
    requireRepoRole(request.user!, repoRow.id, 'maintainer');
    const envRow = resolveEnv(repoRow.id, env);
    guardNoRunningJobs(repoRow.id, 'environment');

    if (body.name !== envRow.name) {
      const clash = db
        .select()
        .from(schema.envs)
        .where(and(eq(schema.envs.repoId, repoRow.id), eq(schema.envs.name, body.name)))
        .all();
      if (clash.length > 0) {
        throw new AppError('CONFLICT', 'env name already exists', 409);
      }

      // renames may re-point stored package refs; the rebuild afterwards
      // regenerates the files that embed the env name (flatpak summary, deb
      // Release suite).
      const renames =
        formats[repoRow.type as RepoType].renameEnv?.(
          { ...envRow, branchMode: repoRow.branchMode },
          body.name,
        ) ?? [];

      db.update(schema.envs).set({ name: body.name }).where(eq(schema.envs.id, envRow.id)).run();

      for (const { oldRef, newRef } of renames) {
        db.update(schema.packages)
          .set({ ref: newRef })
          .where(and(eq(schema.packages.envId, envRow.id), eq(schema.packages.ref, oldRef)))
          .run();
      }

      recordAudit(
        request,
        'env.rename',
        { type: 'env', id: envRow.id, label: `${repoRow.name}/${body.name}` },
        { from: envRow.name, to: body.name },
      );
      const jobId = await enqueueRebuild(repoRow.id, envRow.id);
      return { success: true, data: { id: envRow.id, name: body.name, jobId } };
    }
    return { success: true, data: { id: envRow.id, name: body.name } };
  });

  fastify.get('/:repo/diff', async (request) => {
    const { repo } = request.params as { repo: string };
    const { from, to } = request.query as { from?: string; to?: string };
    if (!from || !to) {
      throw new AppError('BAD_REQUEST', 'from and to query parameters are required', 400);
    }
    const repoRow = resolveRepo(repo);
    requireRepoRole(request.user!, repoRow.id, 'viewer');
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
        onlyInFrom: sortPackages(
          fromPkgs.filter((p) => !toByFilename.has(p.filename)),
          repoRow.type as RepoType,
        ),
        onlyInTo: sortPackages(
          toPkgs.filter((p) => !fromByFilename.has(p.filename)),
          repoRow.type as RepoType,
        ),
        different: sortPackages(
          fromPkgs.filter((p) => {
            const other = toByFilename.get(p.filename);
            return other !== undefined && other.sha256 !== p.sha256;
          }),
          repoRow.type as RepoType,
        ),
      },
    };
  });
};

export default envsRoutes;
