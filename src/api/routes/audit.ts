import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { queryAudit } from '../../lib/audit.js';
import { requireAdmin } from './auth.js';

const auditQuerySchema = z.object({
  action: z.string().max(64).optional(),
  actor: z.string().max(64).optional(),
  q: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const auditRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/audit', async (request) => {
    requireAdmin(request);
    const query = auditQuerySchema.parse(request.query);
    const { rows, total } = queryAudit(query);
    return {
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        at: row.at * 1000,
        actorLogin: row.actorLogin,
        action: row.action,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        subjectLabel: row.subjectLabel,
        details: row.details === null ? null : (JSON.parse(row.details) as unknown),
      })),
      pagination: { limit: query.limit, offset: query.offset, total },
    };
  });
};

export default auditRoutes;
