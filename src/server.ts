import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyRateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from './config.js';
import { AppError } from './errors.js';
import { errorPage } from './lib/errorPage.js';
import { registerAuth } from './api/plugins/auth.js';
import authRoutes from './api/routes/auth.js';
import reposRoutes from './api/routes/repos.js';
import packagesRoutes from './api/routes/packages.js';
import envsRoutes from './api/routes/envs.js';
import jobsRoutes from './api/routes/jobs.js';
import toolchainRoutes from './api/routes/toolchain.js';
import { resolveEnv, resolveRepo } from './lib/repos.js';
import { formats, type RepoType } from './formats/index.js';
import { publicKey } from './gpg/index.js';

const uiRoot = join(import.meta.dirname, '../dist/ui');
const hasUi = existsSync(uiRoot);

const fastifyErrorCodes: Record<string, string> = {
  FST_ERR_CTP_BODY_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  FST_ERR_NOT_FOUND: 'NOT_FOUND',
};

// Browsers get an HTML error page, everything else the JSON envelope.
function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  const acceptsHtml = (request.headers.accept ?? '').includes('text/html');
  if (acceptsHtml && !request.url.startsWith('/api/')) {
    void reply
      .status(status)
      .type('text/html')
      .send(errorPage(status, code, message));
    return;
  }
  void reply.status(status).send({ success: false, error: { code, message } });
}

export function buildServer() {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: config.MAX_UPLOAD_MB * 1024 * 1024,
    trustProxy: config.TRUST_PROXY,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      sendError(request, reply, error.statusCode, error.code, error.message);
      return;
    }

    if (error instanceof ZodError) {
      sendError(
        request,
        reply,
        400,
        'VALIDATION_ERROR',
        error.issues.map((issue) => issue.message).join('; ') || 'invalid request',
      );
      return;
    }

    const err = error as FastifyError;
    if (err.validation) {
      sendError(request, reply, 400, 'VALIDATION_ERROR', err.message);
      return;
    }

    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      sendError(
        request,
        reply,
        err.statusCode,
        fastifyErrorCodes[err.code] ?? 'BAD_REQUEST',
        err.message,
      );
      return;
    }

    request.log.error(err);
    sendError(request, reply, 500, 'INTERNAL_ERROR', err.message || 'Internal server error');
  });

  app.setNotFoundHandler((request, reply) => {
    sendError(request, reply, 404, 'NOT_FOUND', 'resource not found');
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

  // Session cookies need cookie parsing; request cookies are set by auth routes.
  void app.register(fastifyCookie);

  // Reads stay unlimited so package managers can burst; only writes are
  // throttled. Disabled in tests and when RATE_LIMIT_MAX=0.
  if (config.RATE_LIMIT_MAX > 0 && config.NODE_ENV !== 'test') {
    void app.register(fastifyRateLimit, {
      max: config.RATE_LIMIT_MAX,
      timeWindow: config.RATE_LIMIT_WINDOW_S * 1000,
      allowList: (request) => request.method === 'GET' || request.method === 'HEAD',
      errorResponseBuilder: () => ({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'too many write requests, slow down' },
      }),
    });
  }

  registerAuth(app);

  void app.register(authRoutes, { prefix: '/api/v1' });
  void app.register(toolchainRoutes, { prefix: '/api/v1/toolchain' });
  void app.register(reposRoutes, { prefix: '/api/v1/repos' });
  void app.register(packagesRoutes, { prefix: '/api/v1/repos' });
  void app.register(envsRoutes, { prefix: '/api/v1/repos' });
  void app.register(jobsRoutes, { prefix: '/api/v1/jobs' });

  const reposRoot = resolve(config.DATA_DIR, 'repos');
  mkdirSync(reposRoot, { recursive: true });

  // Register the static plugin only for reply.sendFile(); we define the /r/
  // route ourselves so we can translate the env *name* (e.g. "stable") to the
  // env UUID directory on disk.
  void app.register(fastifyStatic, { root: reposRoot, serve: false });

  // The repo public key is machine-readable for clients (dnf gpgkey=, curl in
  // setup snippets), so it lives in the public /r/ zone, not behind the API.
  app.get('/r/:repo/:env/gpg-public-key', async (request: FastifyRequest, reply: FastifyReply) => {
    const { repo } = request.params as { repo: string };
    const repoRow = resolveRepo(repo);
    const armored = publicKey(repoRow.id);
    if (!armored) {
      throw new AppError('NOT_FOUND', 'no gpg key for repo', 404);
    }
    void reply.type('text/plain; charset=utf-8');
    return armored;
  });

  app.get('/r/:repo/:env/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const { repo, env } = request.params as { repo: string; env: string };
    const repoRow = resolveRepo(repo);
    const envRow = resolveEnv(repoRow.id, env);

    const pathname = new URL(request.url, 'http://localhost').pathname;
    const rel = decodeURIComponent(pathname.slice(`/r/${repo}/${env}/`.length));
    const filePath = join(reposRoot, repoRow.id, envRow.id, rel);
    const resolved = resolve(filePath);
    if (!resolved.startsWith(reposRoot + '/') && resolved !== reposRoot) {
      throw new AppError('NOT_FOUND', 'invalid path', 404);
    }

    const headers = formats[repoRow.type as RepoType].serveHeaders(resolved);
    for (const [key, value] of Object.entries(headers)) {
      void reply.header(key, value);
    }

    return reply.sendFile(join(repoRow.id, envRow.id, rel), reposRoot);
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
