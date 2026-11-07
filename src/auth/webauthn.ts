import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { and, eq } from 'drizzle-orm';

const RP_NAME = 'Packratter';

/**
 * The ceremony must bind to the origin the browser is actually using —
 * localhost, 127.0.0.1 or a LAN name each count as their own origin, and
 * BASE_URL may name any one of them. Prefer the Origin header (exactly what
 * the browser sent), fall back to the request host.
 */
export function ceremonyOrigin(request: FastifyRequest): string {
  const origin = request.headers.origin;
  if (origin) return origin;
  return `${request.protocol}://${request.headers.host ?? 'localhost'}`;
}

function rpIdFor(origin: string): string {
  return new URL(origin).hostname;
}

export async function registrationOptions(userId: string, login: string, origin: string) {
  const existing = db
    .select()
    .from(schema.webauthnCredentials)
    .where(eq(schema.webauthnCredentials.userId, userId))
    .all();
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpIdFor(origin),
    userName: login,
    userID: new TextEncoder().encode(userId),
    attestationType: 'none',
    excludeCredentials: existing.map((row) => ({ id: row.id })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
}

export async function verifyRegistration(
  response: RegistrationResponseJSON,
  challenge: string,
  origin: string,
) {
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpIdFor(origin),
  });
  const info = verification.registrationInfo;
  if (!verification.verified || !info) {
    throw new Error('registration verification failed');
  }
  return {
    credentialId: info.credential.id,
    publicKey: Buffer.from(info.credential.publicKey).toString('base64'),
    counter: info.credential.counter,
    transports: response.response.transports ?? null,
  };
}

export async function authenticationOptions(credentialIds: string[], origin: string) {
  return generateAuthenticationOptions({
    rpID: rpIdFor(origin),
    allowCredentials: credentialIds.map((id) => ({ id })),
    userVerification: 'preferred',
  });
}

export async function verifyAuthentication(
  credentialId: string,
  response: AuthenticationResponseJSON,
  challenge: string,
  origin: string,
): Promise<{ newCounter: number }> {
  const row = db
    .select()
    .from(schema.webauthnCredentials)
    .where(eq(schema.webauthnCredentials.id, credentialId))
    .all()[0];
  if (!row) {
    throw new Error('unknown credential');
  }
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpIdFor(origin),
    credential: {
      id: row.id,
      publicKey: Buffer.from(row.publicKey, 'base64'),
      counter: row.counter,
      transports: row.transports
        ? (JSON.parse(row.transports) as ('usb' | 'ble' | 'nfc' | 'internal' | 'hybrid')[])
        : undefined,
    },
  });
  if (!verification.verified) {
    throw new Error('authentication verification failed');
  }
  return { newCounter: verification.authenticationInfo.newCounter };
}

export function credentialRow(userId: string, credentialId: string) {
  return db
    .select()
    .from(schema.webauthnCredentials)
    .where(
      and(
        eq(schema.webauthnCredentials.id, credentialId),
        eq(schema.webauthnCredentials.userId, userId),
      ),
    )
    .all()[0];
}

/** The challenge an assertion answers travels inside its clientDataJSON. */
export function clientChallenge(response: { response: { clientDataJSON: string } }): string | null {
  try {
    const clientData: unknown = JSON.parse(
      Buffer.from(response.response.clientDataJSON, 'base64url').toString(),
    );
    if (typeof clientData !== 'object' || clientData === null) return null;
    const challenge = (clientData as { challenge?: unknown }).challenge;
    return typeof challenge === 'string' ? challenge : null;
  } catch {
    return null;
  }
}
