import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

const TOKEN_PREFIX = 'pkt_';
const PREFIX_LENGTH = 12;

export async function generateToken(): Promise<{ token: string; prefix: string; hash: string }> {
  const secret = randomBytes(32).toString('base64url');
  const token = `${TOKEN_PREFIX}${secret}`;
  const prefix = secret.slice(0, PREFIX_LENGTH);
  const hash = await argon2.hash(token);
  return { token, prefix, hash };
}

export function verifyToken(token: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, token);
}
