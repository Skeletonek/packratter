import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { config } from '../config.js';
import { run, CommandError } from '../lib/exec.js';
import { nowSeconds } from '../lib/time.js';

export function gpgHome(repoId: string): string {
  // Resolve relative paths against the server working directory so spawnSync
  // with a different cwd still finds the keyring.
  return resolve(config.GPG_ROOT, repoId);
}

/** Passphrase for the repo's key, one mode-600 file per repo. */
export function passphraseFile(repoId: string): string {
  return join(dirname(resolve(config.GPG_ROOT)), 'passphrases', repoId);
}

function signPassphraseArgs(repoId: string): string[] {
  const file = passphraseFile(repoId);
  return existsSync(file) ? ['--passphrase-file', file] : ['--passphrase', ''];
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

function signEnv(repoId: string): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: 'C', GNUPGHOME: gpgHome(repoId) };
}

async function runSign(
  repoId: string,
  fingerprint: string,
  args: string[],
  input: string,
  output: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    await run(
      'gpg',
      [
        '--batch',
        '--pinentry-mode',
        'loopback',
        ...signPassphraseArgs(repoId),
        '--default-key',
        fingerprint,
        '--yes',
        ...args,
        '-o',
        output,
        input,
      ],
      { env: signEnv(repoId) },
      log,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(
      `gpg signing failed for ${input}: ${message}`,
      err instanceof CommandError ? err.code : 'COMMAND_FAILED',
    );
  }
}

export async function detachSign(
  repoId: string,
  fingerprint: string,
  input: string,
  output: string,
  log: (line: string) => void,
  armored = false,
): Promise<void> {
  await runSign(
    repoId,
    fingerprint,
    armored ? ['--armor', '--detach-sign'] : ['--detach-sign'],
    input,
    output,
    log,
  );
}

export async function clearSign(
  repoId: string,
  fingerprint: string,
  input: string,
  output: string,
  log: (line: string) => void,
): Promise<void> {
  await runSign(repoId, fingerprint, ['--clearsign'], input, output, log);
}

export function repoFingerprint(repoId: string): string | undefined {
  const key = db
    .select({ fingerprint: schema.gpgKeys.fingerprint })
    .from(schema.repoKeys)
    .innerJoin(schema.gpgKeys, eq(schema.repoKeys.keyId, schema.gpgKeys.id))
    .where(and(eq(schema.repoKeys.repoId, repoId), eq(schema.repoKeys.active, true)))
    .all()[0];
  return key?.fingerprint;
}

export function publicKey(repoId: string): string | undefined {
  const key = db
    .select({ publicArmored: schema.gpgKeys.publicArmored })
    .from(schema.repoKeys)
    .innerJoin(schema.gpgKeys, eq(schema.repoKeys.keyId, schema.gpgKeys.id))
    .where(and(eq(schema.repoKeys.repoId, repoId), eq(schema.repoKeys.active, true)))
    .all()[0];
  return key?.publicArmored;
}

/** Any key ever linked to the repo — including replaced ones kept for transition. */
export function publicKeyByFingerprint(repoId: string, fingerprint: string): string | undefined {
  const key = db
    .select({ publicArmored: schema.gpgKeys.publicArmored })
    .from(schema.repoKeys)
    .innerJoin(schema.gpgKeys, eq(schema.repoKeys.keyId, schema.gpgKeys.id))
    .where(and(eq(schema.repoKeys.repoId, repoId), eq(schema.gpgKeys.fingerprint, fingerprint)))
    .all()[0];
  return key?.publicArmored;
}

export function generateRepoKey(repoId: string): string {
  ensureGpgHome(repoId);
  const result = spawnSync(
    'gpg',
    [
      ...gpgArgs(repoId),
      '--batch',
      '--passphrase',
      '',
      '--quick-gen-key',
      `Packratter ${repoId}`,
      'default',
      'default',
      'never',
    ],
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

  registerKey(repoId, fingerprint, pub.stdout);
  return fingerprint;
}

/** Records the key and makes it the repo's one active signing key. */
function registerKey(repoId: string, fingerprint: string, publicArmored: string): void {
  db.insert(schema.gpgKeys)
    .values({ id: randomUUID(), fingerprint, publicArmored, createdAt: nowSeconds() })
    .onConflictDoNothing({ target: schema.gpgKeys.fingerprint })
    .run();
  const keyRow = db
    .select()
    .from(schema.gpgKeys)
    .where(eq(schema.gpgKeys.fingerprint, fingerprint))
    .all()[0];
  if (!keyRow) {
    throw new Error('gpg key row not found after insert');
  }

  // Replaced keys stay linked (public-downloadable) but stop signing.
  db.update(schema.repoKeys).set({ active: false }).where(eq(schema.repoKeys.repoId, repoId)).run();
  db.insert(schema.repoKeys)
    .values({ repoId, keyId: keyRow.id, active: true })
    .onConflictDoUpdate({
      target: [schema.repoKeys.repoId, schema.repoKeys.keyId],
      set: { active: true },
    })
    .run();
}

export interface ImportedKey {
  fingerprint: string;
}

/**
 * Imports an armored private key as the repo's signing key. Validates at
 * import time — secret key present, passphrase correct (test sign) — so a bad
 * key fails here instead of at the first rebuild. Existing keys are replaced:
 * they stay public-downloadable, but the homedir wipe retires their private
 * material. An optional passphrase is stored in a mode-600 file that runSign
 * picks up.
 */
export function importRepoKey(
  repoId: string,
  armoredPrivate: string,
  passphrase?: string,
): ImportedKey {
  // Fresh homedir: one signing key per repo, no leftovers from the old one.
  rmSync(gpgHome(repoId), { recursive: true, force: true });
  ensureGpgHome(repoId);

  const imp = spawnSync('gpg', [...gpgArgs(repoId), '--batch', '--import'], {
    encoding: 'utf8',
    input: armoredPrivate,
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (imp.status !== 0) {
    throw new Error(`gpg import failed: ${imp.stderr}`);
  }

  const secret = spawnSync('gpg', [...gpgArgs(repoId), '--with-colons', '--list-secret-keys'], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  const fingerprint = secret.stdout
    .split('\n')
    .find((line) => line.startsWith('fpr'))
    ?.split(':')[9];
  if (secret.status !== 0 || !fingerprint) {
    throw new Error('imported data contains no usable secret key');
  }

  if (passphrase !== undefined) {
    storePassphrase(repoId, passphrase);
  } else {
    clearPassphrase(repoId);
  }

  // Prove the key really signs with the given passphrase before wiring it in.
  const probe = join(gpgHome(repoId), 'probe');
  writeFileSync(probe, 'packratter key probe');
  try {
    const sig = spawnSync(
      'gpg',
      [
        ...gpgArgs(repoId),
        '--batch',
        '--pinentry-mode',
        'loopback',
        ...signPassphraseArgs(repoId),
        '--default-key',
        fingerprint,
        '--detach-sign',
        '-o',
        `${probe}.sig`,
        probe,
      ],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
    );
    if (sig.status !== 0) {
      throw new Error('key cannot sign — wrong passphrase?');
    }
  } finally {
    rmSync(probe, { force: true });
    rmSync(`${probe}.sig`, { force: true });
  }

  const pub = spawnSync('gpg', [...gpgArgs(repoId), '--armor', '--export', fingerprint], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (pub.status !== 0) {
    throw new Error(`gpg public key export failed: ${pub.stderr}`);
  }

  registerKey(repoId, fingerprint, pub.stdout);
  return { fingerprint };
}

export function storePassphrase(repoId: string, passphrase: string): void {
  const file = passphraseFile(repoId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, passphrase, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function clearPassphrase(repoId: string): void {
  rmSync(passphraseFile(repoId), { force: true });
}
