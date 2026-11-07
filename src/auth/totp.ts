import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of input.toUpperCase().replace(/=+$/, '')) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** 160-bit secret, base32-encoded as authenticator apps expect. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, timestampMs = Date.now()): string {
  const counter = Math.floor(timestampMs / 1000 / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      (hmac[offset + 1] << 16) |
      (hmac[offset + 2] << 8) |
      hmac[offset + 3]) %
    1_000_000;
  return code.toString().padStart(6, '0');
}

/**
 * Returns the 30-second time-step whose code matched (±1 step of drift
 * tolerance), or null. Callers that accept the code must record the step to
 * prevent the same code being replayed within its validity window.
 */
export function matchTotpStep(secret: string, code: string): number | null {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const now = Date.now();
  for (const driftMs of [-30_000, 0, 30_000]) {
    const counter = Math.floor((now + driftMs) / 1000 / 30);
    const expected = totpCode(secret, now + driftMs);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) {
      return counter;
    }
  }
  return null;
}

export function verifyTotpCode(secret: string, code: string): boolean {
  return matchTotpStep(secret, code) !== null;
}

export function otpauthUri(secret: string, accountName: string, issuer = 'Packratter'): string {
  // Key URI format: label is "Issuer:account", each part encoded, colon literal.
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

const RECOVERY_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** 10 one-time codes, 5 groups of 4 readable characters. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const chars = Array.from(
      { length: 20 },
      () => RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)],
    );
    return [0, 4, 8, 12, 16].map((i) => chars.slice(i, i + 4).join('')).join('-');
  });
}
