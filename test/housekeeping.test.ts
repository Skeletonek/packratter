import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { applyMigrations, db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { sweep } from '../src/lib/housekeeping.js';

describe('housekeeping sweep', () => {
  it('deletes aged jobs and audit entries but keeps fresh ones', async () => {
    applyMigrations();
    await bootstrapAdmin();
    const admin = db.select().from(schema.users).where(eq(schema.users.login, 'admin')).all()[0];
    const now = Math.floor(Date.now() / 1000);

    const oldJobId = randomUUID();
    const freshJobId = randomUUID();
    db.insert(schema.jobs)
      .values({ id: oldJobId, kind: 'rebuild', status: 'done', createdAt: now - 31 * 86400 })
      .run();
    db.insert(schema.jobs)
      .values({ id: freshJobId, kind: 'rebuild', status: 'done', createdAt: now - 86400 })
      .run();

    const oldAuditId = randomUUID();
    const freshAuditId = randomUUID();
    db.insert(schema.auditLog)
      .values({ id: oldAuditId, at: now - 366 * 86400, actorLogin: 'admin', action: 'user.update' })
      .run();
    db.insert(schema.auditLog)
      .values({ id: freshAuditId, at: now - 86400, actorLogin: 'admin', action: 'user.update' })
      .run();

    sweep();

    const jobs = db.select().from(schema.jobs).all();
    expect(jobs.find((j) => j.id === oldJobId)).toBeUndefined();
    expect(jobs.find((j) => j.id === freshJobId)).toBeDefined();

    const audit = db.select().from(schema.auditLog).all();
    expect(audit.find((a) => a.id === oldAuditId)).toBeUndefined();
    expect(audit.find((a) => a.id === freshAuditId)).toBeDefined();

    // cleanup so other suites see a clean table
    db.delete(schema.jobs).all();
    void admin;
  });

  it('deletes expired sessions and rotted tokens', async () => {
    applyMigrations();
    await bootstrapAdmin();
    const admin = db.select().from(schema.users).where(eq(schema.users.login, 'admin')).all()[0];
    const now = Math.floor(Date.now() / 1000);

    const expiredSession = randomUUID();
    const liveSession = randomUUID();
    db.insert(schema.sessions)
      .values({ id: expiredSession, userId: admin.id, expiresAt: now - 60 })
      .run();
    db.insert(schema.sessions)
      .values({ id: liveSession, userId: admin.id, expiresAt: now + 3600 })
      .run();

    const expiredToken = randomUUID();
    const staleToken = randomUUID();
    const liveToken = randomUUID();
    for (const [id, expiresAt, lastUsedAt] of [
      [expiredToken, now - 60, null],
      [staleToken, null, now - 91 * 86400],
      [liveToken, null, now],
    ] as [string, number | null, number | null][]) {
      db.insert(schema.tokens)
        .values({
          id,
          userId: admin.id,
          prefix: id.slice(0, 12),
          hash: 'x',
          scopes: 'admin',
          createdAt: now,
          expiresAt,
          lastUsedAt,
        })
        .run();
    }

    sweep();

    const sessions = db.select().from(schema.sessions).all();
    expect(sessions.find((s) => s.id === expiredSession)).toBeUndefined();
    expect(sessions.find((s) => s.id === liveSession)).toBeDefined();

    const tokens = db.select().from(schema.tokens).all();
    expect(tokens.find((t) => t.id === expiredToken)).toBeUndefined();
    expect(tokens.find((t) => t.id === staleToken)).toBeUndefined();
    expect(tokens.find((t) => t.id === liveToken)).toBeDefined();

    db.delete(schema.sessions).where(eq(schema.sessions.id, liveSession)).run();
    db.delete(schema.tokens).where(eq(schema.tokens.id, liveToken)).run();
  });
});
