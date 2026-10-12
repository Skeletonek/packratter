import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; login: string; role: string };
  }
}
