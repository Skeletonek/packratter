import { createHash, timingSafeEqual } from 'node:crypto';
import { generateRecoveryCodes } from './totp.js';

/**
 * Recovery codes are high-entropy one-time secrets, so sha256 is enough
 * protection — same reasoning as session ids. Each code works once.
 */
function hashCode(code: string): string {
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}

export function issueRecoveryCodes(): { codes: string[]; stored: string } {
  const codes = generateRecoveryCodes();
  return { codes, stored: JSON.stringify(codes.map(hashCode)) };
}

export function parseStoredHashes(stored: string | null): string[] {
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

/** Returns the remaining hashes with the used one removed, or null when no match. */
export function consumeRecoveryCode(
  stored: string | null,
  code: string,
): { remaining: string[]; matched: boolean } {
  const hashes = parseStoredHashes(stored);
  const candidate = Buffer.from(hashCode(code));
  for (let i = 0; i < hashes.length; i++) {
    const known = Buffer.from(hashes[i]);
    if (known.length === candidate.length && timingSafeEqual(known, candidate)) {
      return { remaining: hashes.filter((_, j) => j !== i), matched: true };
    }
  }
  return { remaining: hashes, matched: false };
}
