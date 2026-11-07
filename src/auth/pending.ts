import { randomBytes } from 'node:crypto';

/**
 * Two-phase login: the password step stashes the user here and the second
 * factor completes it. In-memory on purpose — a restart just makes the user
 * retry, and nothing sensitive survives longer than the TTL.
 */
interface PendingLogin {
  userId: string;
  methods: string[];
  expiresAt: number;
  failures: number;
}

const PENDING_TTL_MS = 5 * 60_000;
/** Guesses allowed per pending token before it is burned. */
const MAX_FAILURES = 5;

const pendingLogins = new Map<string, PendingLogin>();

export function createPendingLogin(userId: string, methods: string[]): string {
  purgeExpiredPending();
  const token = randomBytes(32).toString('base64url');
  pendingLogins.set(token, {
    userId,
    methods,
    expiresAt: Date.now() + PENDING_TTL_MS,
    failures: 0,
  });
  return token;
}

export function takePendingLogin(token: string): PendingLogin | null {
  purgeExpiredPending();
  const entry = pendingLogins.get(token);
  if (!entry) return null;
  pendingLogins.delete(token);
  return entry;
}

/** Peek without consuming — the user may try several factors for one login. */
export function peekPendingLogin(token: string): PendingLogin | null {
  purgeExpiredPending();
  return pendingLogins.get(token) ?? null;
}

export function consumePendingLogin(token: string): void {
  pendingLogins.delete(token);
}

/** Burns the token after too many wrong codes — bounds factor guessing. */
export function recordFailure(token: string): void {
  const entry = pendingLogins.get(token);
  if (!entry) return;
  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    pendingLogins.delete(token);
  }
}

function purgeExpiredPending(): void {
  const now = Date.now();
  for (const [key, entry] of pendingLogins) {
    if (entry.expiresAt <= now) pendingLogins.delete(key);
  }
}
