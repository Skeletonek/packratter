import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  otpauthUri,
  totpCode,
  verifyTotpCode,
} from '../src/auth/totp.js';
import {
  consumeRecoveryCode,
  issueRecoveryCodes,
  parseStoredHashes,
} from '../src/auth/recovery.js';

describe('base32', () => {
  it('round-trips bytes', () => {
    const bytes = Buffer.from('hello world, this is a secret!!');
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it('rejects invalid characters', () => {
    expect(() => base32Decode('1!')).toThrow();
  });
});

describe('totp', () => {
  // RFC 6238 Appendix B: SHA-1, 8-digit vectors, scaled to the 6-digit variant
  // our implementation uses (same HOTP truncation, modulo 10^6).
  const rfcSecret = base32Encode(Buffer.from('3132333435363738393031323334353637383930', 'hex'));

  it('matches the RFC 6238 reference vectors (last 6 digits)', () => {
    const vectors: [number, string][] = [
      [59, '287082'], // 94287082
      [1111111109, '081804'], // 07081804
      [1111111111, '050471'], // 14050471
      [1234567890, '005924'], // 89005924
      [2000000000, '279037'], // 69279037
    ];
    for (const [seconds, expected] of vectors) {
      expect(totpCode(rfcSecret, seconds * 1000)).toBe(expected);
    }
  });

  it('verifies a current code', () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, totpCode(secret))).toBe(true);
  });

  it('tolerates one step of clock drift', () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, totpCode(secret, Date.now() - 30_000))).toBe(true);
    expect(verifyTotpCode(secret, totpCode(secret, Date.now() + 30_000))).toBe(true);
  });

  it('rejects a code from two steps away', () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, totpCode(secret, Date.now() - 60_000))).toBe(false);
    expect(verifyTotpCode(secret, totpCode(secret, Date.now() + 60_000))).toBe(false);
  });

  it('rejects malformed codes without throwing', () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, 'abcdef')).toBe(false);
    expect(verifyTotpCode(secret, '')).toBe(false);
    expect(verifyTotpCode(secret, '1234567')).toBe(false);
  });

  it('generates 160-bit base32 secrets', () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('builds a standards-shaped otpauth uri', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'alice');
    expect(uri).toMatch(/^otpauth:\/\/totp\/Packratter:alice\?/);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
  });
});

describe('recovery codes', () => {
  it('issues 10 unique readable codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){4}$/);
    }
  });

  it('stores only hashes, never the codes', () => {
    const { codes, stored } = issueRecoveryCodes();
    const hashes = parseStoredHashes(stored);
    expect(hashes).toHaveLength(10);
    for (const code of codes) {
      expect(stored).not.toContain(code);
    }
  });

  it('consumes a matching code exactly once', () => {
    const { codes, stored } = issueRecoveryCodes();
    const first = consumeRecoveryCode(stored, codes[0]);
    expect(first.matched).toBe(true);
    expect(first.remaining).toHaveLength(9);

    const second = consumeRecoveryCode(JSON.stringify(first.remaining), codes[0]);
    expect(second.matched).toBe(false);
  });

  it('matches codes case- and whitespace-insensitively', () => {
    const { codes, stored } = issueRecoveryCodes();
    expect(consumeRecoveryCode(stored, `  ${codes[3].toUpperCase()}  `).matched).toBe(true);
  });

  it('rejects unknown codes and survives corrupt storage', () => {
    const { stored } = issueRecoveryCodes();
    expect(consumeRecoveryCode(stored, 'aaaa-bbbb-cccc-dddd-eeee').matched).toBe(false);
    expect(parseStoredHashes('not json')).toEqual([]);
    expect(parseStoredHashes(null)).toEqual([]);
    expect(consumeRecoveryCode('not json', 'aaaa-bbbb-cccc-dddd-eeee').matched).toBe(false);
  });
});
