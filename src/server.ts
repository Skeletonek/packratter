import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { eq, and } from 'drizzle-orm';
import { config } from './config.js';
import { AppError } from './errors.js';
import authPlugin from './api/plugins/auth.js';
import reposRoutes from './api/routes/repos.js';
import packagesRoutes from './api/routes/packages.js';
import jobsRoutes from './api/routes/jobs.js';
import { db } from './db/index.js';
import * as schema from './db/schema.js';
import { formats, type RepoType } from './formats/index.js';

const uiRoot = join(import.meta.dirname, '../dist/ui');
const hasUi = existsSync(uiRoot);

export function buildServer() {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: 2 * 1024 * 1024 * 1024,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }

    const err = error as FastifyError;
    if (err.validation) {
      reply.status(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: err.message },
      });
      return;
    }

    request.log.error(err);
    reply.status(500).send({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal server error' },
    });
  });

  const rawContentTypes = [
    'application/octet-stream',
    'application/zstd',
    'application/x-zstd',
    'application/x-xz',
    'application/gzip',
    'application/x-gzip',
  ];
  for (const contentType of rawContentTypes) {
    app.addContentTypeParser(contentType, { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
  }
  // Catch-all for browsers that send an unexpected MIME type for package files.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.get('/healthz', () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  void app.register(authPlugin);

  void app.register(reposRoutes, { prefix: '/api/v1/repos' });
  void app.register(packagesRoutes, { prefix: '/api/v1/repos' });
  void app.register(jobsRoutes, { prefix: '/api/v1/jobs' });

  const reposRoot = resolve(config.DATA_DIR, 'repos');
  mkdirSync(reposRoot, { recursive: true });

  // Register the static plugin only for reply.sendFile(); we define the /r/
  // route ourselves so we can translate the env *name* (e.g. "stable") to the
  // env UUID directory on disk.
  void app.register(fastifyStatic, { root: reposRoot, serve: false });

  app.get('/r/:repo/:env/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const { repo, env } = request.params as { repo: string; env: string };
    const repoRow = db.select().from(schema.repos).where(eq(schema.repos.id, repo)).all()[0];
    if (!repoRow) throw new AppError('NOT_FOUND', 'repo not found', 404);
    const envRow = db
      .select()
      .from(schema.envs)
      .where(and(eq(schema.envs.repoId, repo), eq(schema.envs.name, env)))
      .all()[0];
    if (!envRow) throw new AppError('NOT_FOUND', 'env not found', 404);

    const pathname = new URL(request.url, 'http://localhost').pathname;
    const rel = decodeURIComponent(pathname.slice(`/r/${repo}/${env}/`.length));
    const filePath = join(reposRoot, repo, envRow.id, rel);
    const resolved = resolve(filePath);
    if (!resolved.startsWith(reposRoot + '/') && resolved !== reposRoot) {
      throw new AppError('NOT_FOUND', 'invalid path', 404);
    }

    const headers = formats[repoRow.type as RepoType].serveHeaders(resolved);
    for (const [key, value] of Object.entries(headers)) {
      void reply.header(key, value);
    }

    return reply.sendFile(join(repo, envRow.id, rel), reposRoot);
  });

  if (hasUi) {
    // Root Convenience redirect to the UI entry.
    app.get('/', (_request: FastifyRequest, reply: FastifyReply) => {
      void reply.header('cache-control', 'no-store');
      return reply.redirect('/app/', 302);
    });

    app.get('/app', (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.sendFile('index.html', uiRoot);
    });

    // Serve real dist files; everything else falls back to the SPA index.
    app.get('/app/*', (request: FastifyRequest, reply: FastifyReply) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const rel = decodeURIComponent(pathname.slice('/app/'.length));
      const filePath = rel ? join(uiRoot, rel) : join(uiRoot, 'index.html');
      const isRealFile = existsSync(filePath) && statSync(filePath).isFile();
      const target = isRealFile ? rel : 'index.html';
      return reply.sendFile(target, uiRoot);
    });
  }

  return app;
}
