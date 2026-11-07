import { lt, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { config } from '../config.js';
import { nowSeconds } from './time.js';

/**
 * One sweep reclaims everything that expires on its own: finished jobs, aged
 * audit entries, dead sessions and rotted tokens. Runs at boot and then daily;
 * the interval is unref'd so it never holds the process open.
 */
export function sweep(): void {
  const now = nowSeconds();

  db.delete(schema.jobs)
    .where(lt(schema.jobs.createdAt, now - config.JOB_RETENTION_DAYS * 86400))
    .run();

  if (config.AUDIT_RETENTION_DAYS > 0) {
    db.delete(schema.auditLog)
      .where(lt(schema.auditLog.at, now - config.AUDIT_RETENTION_DAYS * 86400))
      .run();
  }

  db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now)).run();

  db.delete(schema.tokens)
    .where(or(lt(schema.tokens.expiresAt, now), lt(schema.tokens.lastUsedAt, now - 90 * 86400)))
    .run();
}

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function startHousekeeping(): void {
  sweep();
  setInterval(sweep, SWEEP_INTERVAL_MS).unref();
}
