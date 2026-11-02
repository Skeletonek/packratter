import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { AppError } from '../../errors.js';
import { SESSION_COOKIE, createSession } from '../../auth/sessions.js';
import {
  SSO_STATE_COOKIE,
  STATE_TTL_SECONDS,
  authorizationUrl,
  decodePending,
  encodePending,
  exchangeCode,
  newPendingAuth,
  policyFromConfig,
  resolveSsoUser,
  ssoEnabled,
} from '../../auth/sso.js';

const SSO_PATH = '/api/v1/auth/sso';

function callbackUrl(request: FastifyRequest): string {
  const base = (
    config.BASE_URL ?? `${request.protocol}://${request.headers.host ?? `localhost:${config.PORT}`}`
  ).replace(/\/$/, '');
  return `${base}${SSO_PATH}/callback`;
}

const ssoRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/auth/sso/status', async () => ({
    success: true,
    data: { enabled: ssoEnabled() },
  }));

  fastify.get('/auth/sso/start', async (request, reply) => {
    if (!ssoEnabled()) {
      throw new AppError('NOT_FOUND', 'SSO sign-in is not configured', 404);
    }
    const pending = newPendingAuth();
    const url = await authorizationUrl(callbackUrl(request), pending);
    reply.setCookie(SSO_STATE_COOKIE, encodePending(pending), {
      path: SSO_PATH,
      httpOnly: true,
      sameSite: 'lax',
      secure: config.NODE_ENV === 'production',
      maxAge: STATE_TTL_SECONDS,
    });
    return reply.redirect(url, 302);
  });

  fastify.get('/auth/sso/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };
    const pending = decodePending((request.cookies as Record<string, string>)[SSO_STATE_COOKIE]);
    reply.clearCookie(SSO_STATE_COOKIE, { path: SSO_PATH });

    const fail = (reason: string) => reply.redirect(`/login?sso=${reason}`, 302);
    if (!ssoEnabled()) return fail('failed');
    if (!code || !state || !pending || pending.state !== state) return fail('failed');

    try {
      const info = await exchangeCode(code, pending.verifier, callbackUrl(request));
      const { user } = resolveSsoUser(info, policyFromConfig());
      const session = createSession(user.id, false);
      reply.setCookie(SESSION_COOKIE, session.cookieValue, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.NODE_ENV === 'production',
        ...(session.maxAge === undefined ? {} : { maxAge: session.maxAge }),
      });
      return reply.redirect('/', 302);
    } catch (err) {
      if (err instanceof AppError && err.code === 'SSO_DENIED') return fail('denied');
      request.log.error({ err }, 'SSO callback failed');
      return fail('failed');
    }
  });
};

export default ssoRoutes;
