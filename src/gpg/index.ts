import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { config } from '../config.js';
import { nowSeconds } from '../lib/time.js';

export function gpgHome(repoId: string): string {
  // Resolve relative paths against the server working directory so spawnSync
  // with a different cwd still finds the keyring.
  return resolve(config.GPG_ROOT, repoId);
}

export function ensureGpgHome(repoId: string): string {
  const dir = gpgHome(repoId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function gpgArgs(repoId: string): string[] {
  return ['--homedir', gpgHome(repoId)];
}

export function repoFingerprint(repoId: string): string | undefined {
  const key = db
    .select({ fingerprint: schema.gpgKeys.fingerprint })
    .from(schema.repoKeys)
    .innerJoin(schema.gpgKeys, eq(schema.repoKeys.keyId, schema.gpgKeys.id))
    .where(eq(schema.repoKeys.repoId, repoId))
    .all()[0];
  return key?.fingerprint;
}

export function publicKey(repoId: string): string | undefined {
  const key = db
    .select({ publicArmored: schema.gpgKeys.publicArmored })
    .from(schema.repoKeys)
    .innerJoin(schema.gpgKeys, eq(schema.repoKeys.keyId, schema.gpgKeys.id))
    .where(eq(schema.repoKeys.repoId, repoId))
    .all()[0];
  return key?.publicArmored;
}

export function generateRepoKey(repoId: string): string {
  ensureGpgHome(repoId);
  const result = spawnSync(
    'gpg',
    [...gpgArgs(repoId), '--batch', '--passphrase', '', '--quick-gen-key', `Packratter ${repoId}`, 'default', 'default', 'never'],
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
  );
  if (result.status !== 0) {
    throw new Error(`gpg key generation failed: ${result.stderr}`);
  }

  const list = spawnSync('gpg', [...gpgArgs(repoId), '--with-colons', '--list-keys'], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  const fprLine = list.stdout.split('\n').find((line) => line.startsWith('fpr'));
  if (!fprLine) {
    throw new Error('could not determine key fingerprint');
  }
  const fingerprint = fprLine.split(':')[9];
  if (!fingerprint) {
    throw new Error('could not parse key fingerprint');
  }

  const pub = spawnSync('gpg', [...gpgArgs(repoId), '--armor', '--export', fingerprint], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (pub.status !== 0) {
    throw new Error(`gpg public key export failed: ${pub.stderr}`);
  }

  db.insert(schema.gpgKeys)
    .values({ id: randomUUID(), fingerprint, publicArmored: pub.stdout, createdAt: nowSeconds() })
    .run();
  const keyRow = db.select().from(schema.gpgKeys).where(eq(schema.gpgKeys.fingerprint, fingerprint)).all()[0];
  if (!keyRow) {
    throw new Error('gpg key row not found after insert');
  }

  db.insert(schema.repoKeys).values({ repoId, keyId: keyRow.id }).run();
  return fingerprint;
}
