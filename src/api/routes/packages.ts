import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { AppError } from '../../errors.js';
import { config } from '../../config.js';
import { nowSeconds } from '../../lib/time.js';
import { resolveEnv, resolveRepo } from '../../lib/repos.js';
import { assertTypeAvailable, scanToolchain } from '../../lib/toolchain.js';
import { formats, type RepoType } from '../../formats/index.js';
import type { PackageMeta } from '../../formats/types.js';
import { enqueueRebuild } from '../../jobs/queue.js';

const MAX_SIZE = config.MAX_UPLOAD_MB * 1024 * 1024;

// Quota counts each distinct blob once per repo: promoted copies are
// hardlinks and consume no extra disk.
function repoUsageBytes(repoId: string): number {
  const rows = db
    .select()
    .from(schema.packages)
    .innerJoin(schema.envs, eq(schema.packages.envId, schema.envs.id))
    .where(eq(schema.envs.repoId, repoId))
    .all();
  const blobs = new Map<string, number>();
  for (const row of rows) {
    blobs.set(row.packages.sha256 ?? row.packages.filename, row.packages.size ?? 0);
  }
  let total = 0;
  for (const size of blobs.values()) total += size;
  return total;
}

const uploadExtension: Record<RepoType, string> = {
  pacman: '.pkg.tar.zst',
  deb: '.deb',
  rpm: '.rpm',
  flatpak: '.flatpak',
};

const promoteSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  filenames: z.array(z.string().min(1)).optional(),
});

const packagesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.put(
    '/:repo/:env/packages',
    { config: { bodyLimit: MAX_SIZE } },
    async (request, reply) => {
      const { repo, env } = request.params as { repo: string; env: string };
      const repoRow = resolveRepo(repo);
      const format = formats[repoRow.type as RepoType];

      assertTypeAvailable(repoRow.type as RepoType, await scanToolchain());

      const envRow = { ...resolveEnv(repoRow.id, env), branchMode: repoRow.branchMode };

      const body = request.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new AppError('BAD_REQUEST', 'empty or invalid body', 400);
      }

      const quotaBytes = config.REPO_QUOTA_MB * 1024 * 1024;
      if (quotaBytes > 0 && repoUsageBytes(repoRow.id) + body.length > quotaBytes) {
        throw new AppError(
          'QUOTA_EXCEEDED',
          `upload would exceed the ${config.REPO_QUOTA_MB} MiB quota for this repository`,
          507,
        );
      }

      const tmpDir = join(config.DATA_DIR, 'tmp');
      mkdirSync(tmpDir, { recursive: true });
      const tmpPath = join(tmpDir, `${randomUUID()}${uploadExtension[repoRow.type as RepoType]}`);
      writeFileSync(tmpPath, body);

      const validation = format.validate(tmpPath);
      if (!validation.ok) {
        unlinkSync(tmpPath);
        throw new AppError('VALIDATION_ERROR', validation.error, 400);
      }

      let meta: PackageMeta;
      try {
        meta = format.ingest(envRow, tmpPath, body);
      } catch (err) {
        try {
          unlinkSync(tmpPath);
        } catch {}
        throw new AppError('INGEST_ERROR', String(err), 400);
      }

      db.insert(schema.packages)
        .values({
          id: randomUUID(),
          envId: envRow.id,
          filename: meta.filename,
          version: meta.version,
          arch: meta.arch,
          size: meta.size,
          sha256: meta.sha256,
          ref: meta.ref,
          status: 'pending',
          createdAt: nowSeconds(),
        })
        .run();

      const jobId = await enqueueRebuild(repoRow.id, envRow.id);

      reply.status(202);
      return { success: true, data: { jobId, filename: meta.filename } };
    },
  );

  fastify.delete('/:repo/:env/packages/:filename', async (request) => {
    const { repo, env, filename } = request.params as {
      repo: string;
      env: string;
      filename: string;
    };
    const repoRow = resolveRepo(repo);
    const envRow = resolveEnv(repoRow.id, env);

    const pkg = db
      .select()
      .from(schema.packages)
      .where(and(eq(schema.packages.envId, envRow.id), eq(schema.packages.filename, filename)))
      .all()[0];
    if (!pkg) throw new AppError('NOT_FOUND', 'package not found', 404);

    formats[repoRow.type as RepoType].removePackage(envRow, pkg);
    db.delete(schema.packages).where(eq(schema.packages.id, pkg.id)).run();

    const jobId = await enqueueRebuild(repoRow.id, envRow.id);
    return { success: true, data: { jobId } };
  });

  fastify.post('/:repo/promote', async (request, reply) => {
    const { repo } = request.params as { repo: string };
    const body = promoteSchema.parse(request.body);
    if (body.from === body.to) {
      throw new AppError('BAD_REQUEST', 'from and to must be different envs', 400);
    }
    const repoRow = resolveRepo(repo);
    const fromEnv = { ...resolveEnv(repoRow.id, body.from), branchMode: repoRow.branchMode };
    const toEnv = { ...resolveEnv(repoRow.id, body.to), branchMode: repoRow.branchMode };

    let fromPkgs = db
      .select()
      .from(schema.packages)
      .where(eq(schema.packages.envId, fromEnv.id))
      .all();
    if (body.filenames) {
      const wanted = new Set(body.filenames);
      const selected = fromPkgs.filter((p) => wanted.has(p.filename));
      if (selected.length !== wanted.size) {
        throw new AppError('NOT_FOUND', 'some packages not found in source env', 404);
      }
      fromPkgs = selected;
    }

    const existing = new Set(
      db
        .select()
        .from(schema.packages)
        .where(eq(schema.packages.envId, toEnv.id))
        .all()
        .map((p) => p.filename),
    );

    const format = formats[repoRow.type as RepoType];
    let promoted = 0;
    let skipped = 0;
    for (const pkg of fromPkgs) {
      if (existing.has(pkg.filename)) {
        skipped += 1;
        continue;
      }
      format.promote(fromEnv, toEnv, pkg);
      db.insert(schema.packages)
        .values({
          id: randomUUID(),
          envId: toEnv.id,
          filename: pkg.filename,
          version: pkg.version,
          arch: pkg.arch,
          size: pkg.size,
          sha256: pkg.sha256,
          ref: pkg.ref,
          status: 'pending',
          createdAt: nowSeconds(),
        })
        .run();
      promoted += 1;
    }

    const jobId = promoted > 0 ? await enqueueRebuild(repoRow.id, toEnv.id) : null;

    reply.status(202);
    return { success: true, data: { jobId, promoted, skipped } };
  });
};

export default packagesRoutes;
