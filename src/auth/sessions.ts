import { createHash, randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { config } from '../config.js';
import { nowSeconds } from '../lib/time.js';

export const SESSION_COOKIE = 'pks_session';
const COOKIE_PREFIX = 'pks_';

/**
 * Session ids are 256-bit random secrets; sha256 is enough protection for them
 * (no offline search value), argon2 stays reserved for low-entropy secrets.
 */
function hashCookieValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface CreatedSession {
  cookieValue: string;
  /** Cookie Max-Age in seconds; undefined = browser-session cookie */
  maxAge: number | undefined;
}

export function createSession(userId: string, remember: boolean): CreatedSession {
  const cookieValue = `${COOKIE_PREFIX}${randomBytes(32).toString('base64url')}`;
  const ttlSeconds = remember ? config.SESSION_REMEMBER_DAYS * 86400 : config.SESSION_TTL_MIN * 60;
  db.insert(schema.sessions)
    .values({ id: hashCookieValue(cookieValue), userId, expiresAt: nowSeconds() + ttlSeconds })
    .run();
  return { cookieValue, maxAge: remember ? config.SESSION_REMEMBER_DAYS * 86400 : undefined };
}

export function deleteSession(cookieValue: string): void {
  db.delete(schema.sessions)
    .where(eq(schema.sessions.id, hashCookieValue(cookieValue)))
    .run();
}

export function purgeExpiredSessions(): void {
  db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, nowSeconds())).run();
}

export function sessionUserId(cookieValue: string): string | null {
  if (!cookieValue.startsWith(COOKIE_PREFIX) || cookieValue.length < 40) {
    return null;
  }
  const rows = db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, hashCookieValue(cookieValue)))
    .all();
  const row = rows[0];
  if (!row) {
    return null;
  }
  if (row.expiresAt <= nowSeconds()) {
    db.delete(schema.sessions).where(eq(schema.sessions.id, row.id)).run();
    return null;
  }
  return row.userId;
}
