import { randomUUID } from 'node:crypto';
import { and, desc, like, or, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';

export interface AuditSubject {
  type: string;
  id?: string | null;
  label?: string | null;
}

/**
 * One synchronous insert — audit rows are written after the action succeeded,
 * and a lost audit row is better than a failed action.
 */
export function recordAudit(
  request: FastifyRequest,
  action: string,
  subject?: AuditSubject,
  details?: unknown,
): void {
  const actor = request.user;
  db.insert(schema.auditLog)
    .values({
      id: randomUUID(),
      at: Math.floor(Date.now() / 1000),
      actorId: actor?.id ?? null,
      actorLogin: actor?.login ?? 'anonymous',
      action,
      subjectType: subject?.type ?? null,
      subjectId: subject?.id ?? null,
      subjectLabel: subject?.label ?? null,
      details: details === undefined ? null : JSON.stringify(details),
    })
    .run();
}

export interface AuditQuery {
  action?: string;
  actor?: string;
  q?: string;
  limit: number;
  offset: number;
}

export function queryAudit(query: AuditQuery) {
  const filters = [];
  if (query.action) {
    filters.push(like(schema.auditLog.action, `%${query.action}%`));
  }
  if (query.actor) {
    filters.push(like(schema.auditLog.actorLogin, `%${query.actor}%`));
  }
  if (query.q) {
    const likeQ = `%${query.q}%`;
    filters.push(
      or(
        like(schema.auditLog.subjectLabel, likeQ),
        like(schema.auditLog.subjectId, likeQ),
        like(schema.auditLog.actorLogin, likeQ),
        like(schema.auditLog.details, likeQ),
      ),
    );
  }
  const where = filters.length > 0 ? and(...filters) : undefined;

  const rows = db
    .select()
    .from(schema.auditLog)
    .where(where)
    .orderBy(desc(schema.auditLog.at), desc(schema.auditLog.id))
    .limit(query.limit)
    .offset(query.offset)
    .all();
  const total = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.auditLog)
    .where(where)
    .all()[0].count;

  return { rows, total };
}
