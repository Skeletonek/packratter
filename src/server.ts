import Fastify, { type FastifyError } from 'fastify';
import { config } from './config.js';
import { AppError } from './errors.js';

export function buildServer() {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
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
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  app.get('/healthz', () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  return app;
}
