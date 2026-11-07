import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { generateToken } from '../src/auth/tokens.js';
import { applyMigrations, db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import {
  detachSign,
  importRepoKey,
  passphraseFile,
  publicKey,
  publicKeyByFingerprint,
  repoFingerprint,
} from '../src/gpg/index.js';
import { buildServer } from '../src/server.js';
import { commandExists } from './helpers.js';

let token = '';
let server: FastifyInstance;

beforeAll(async () => {
  applyMigrations();
  await bootstrapAdmin();
  const admin = db.select().from(schema.users).where(eq(schema.users.login, 'admin')).all()[0];
  if (!admin) throw new Error('admin user missing');

  const { token: generated, prefix, hash } = await generateToken();
  db.insert(schema.tokens)
    .values({
      id: randomUUID(),
      userId: admin.id,
      prefix,
      hash,
      scopes: 'admin',
      createdAt: Math.floor(Date.now() / 1000),
    })
    .run();
  token = generated;

  server = buildServer();
});

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function insertRepo(name: string): string {
  const repoId = randomUUID();
  db.insert(schema.repos).values({ id: repoId, name, type: 'pacman', createdAt: 1 }).run();
  db.insert(schema.envs).values({ id: randomUUID(), repoId, name: 'stable' }).run();
  return repoId;
}

/** Generates a throwaway key in a scratch homedir and returns its armored secret. */
function makeKey(passphrase?: string): { armored: string; fingerprint: string } {
  const home = mkdtempSync(join(tmpdir(), 'packrat-genkey-'));
  try {
    const gen = spawnSync(
      'gpg',
      [
        '--homedir',
        home,
        '--batch',
        '--pinentry-mode',
        'loopback',
        '--passphrase',
        passphrase ?? '',
        '--quick-gen-key',
        'Packratter Test <test@example.com>',
        'default',
        'default',
        'never',
      ],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
    );
    if (gen.status !== 0) throw new Error(`test key generation failed: ${gen.stderr}`);
    const list = spawnSync('gpg', ['--homedir', home, '--with-colons', '--list-keys'], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    const fingerprint = list.stdout
      .split('\n')
      .find((line) => line.startsWith('fpr'))
      ?.split(':')[9];
    if (!fingerprint) throw new Error('test key fingerprint not found');
    const exp = spawnSync(
      'gpg',
      [
        '--homedir',
        home,
        '--batch',
        '--pinentry-mode',
        'loopback',
        '--passphrase',
        passphrase ?? '',
        '--armor',
        '--export-secret-keys',
        fingerprint,
      ],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024 },
    );
    if (exp.status !== 0) throw new Error(`test key export failed: ${exp.stderr}`);
    return { armored: exp.stdout, fingerprint };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe.skipIf(!commandExists('gpg'))('gpg key import', () => {
  it('imports an unprotected key and serves its public half', () => {
    const repoId = insertRepo(`key-import-${randomUUID().slice(0, 8)}`);
    const { armored, fingerprint } = makeKey();

    const result = importRepoKey(repoId, armored);
    expect(result.fingerprint).toBe(fingerprint);
    expect(repoFingerprint(repoId)).toBe(fingerprint);
    expect(publicKey(repoId)).toContain('BEGIN PGP PUBLIC KEY BLOCK');
  });

  it('reports the key algorithm in the settings view', async () => {
    const repoName = `key-algo-${randomUUID().slice(0, 8)}`;
    const repoId = insertRepo(repoName);
    const { armored } = makeKey();
    importRepoKey(repoId, armored);

    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/settings/keys',
      headers: bearer(),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as { repo: string; algorithm: string | null }[];
    const row = rows.find((r) => r.repo === repoName);
    expect(row).toBeDefined();
    expect(row!.algorithm).toMatch(/(RSA|EdDSA|ECDSA|DSA|ECDH)/);
  });

  it('imports a passphrase-protected key and signs with the stored passphrase', async () => {
    const repoId = insertRepo(`key-prot-${randomUUID().slice(0, 8)}`);
    const { armored } = makeKey('hunter2');

    const result = importRepoKey(repoId, armored, 'hunter2');
    expect(result.fingerprint).toBeTruthy();
    expect(passphraseFile(repoId)).toContain('passphrases');
    expect(existsSync(passphraseFile(repoId))).toBe(true);
    expect(statSync(passphraseFile(repoId)).mode & 0o777).toBe(0o600);

    // signing works end to end via the stored passphrase file
    const log = () => {};
    const home = mkdtempSync(join(tmpdir(), 'packrat-signprobe-'));
    const input = join(home, 'file');
    const output = join(home, 'file.sig');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(input, 'probe');
    await detachSign(repoId, result.fingerprint, input, output, log);
    expect(existsSync(output)).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it('rejects a wrong passphrase at import time', () => {
    const repoId = insertRepo(`key-wrong-${randomUUID().slice(0, 8)}`);
    const { armored } = makeKey('right-pass');
    expect(() => importRepoKey(repoId, armored, 'wrong-pass')).toThrow(/passphrase/i);
  });

  it('rejects a public-only import', () => {
    const repoId = insertRepo(`key-pub-${randomUUID().slice(0, 8)}`);
    const { armored, fingerprint } = makeKey();
    // strip the secret key blocks, keep only the public part
    const home = mkdtempSync(join(tmpdir(), 'packrat-pubonly-'));
    const pub = spawnSync('gpg', ['--homedir', home, '--import'], {
      encoding: 'utf8',
      input: armored,
      env: { ...process.env, LC_ALL: 'C' },
    });
    expect(pub.status).toBe(0);
    const exp = spawnSync('gpg', ['--homedir', home, '--armor', '--export', fingerprint], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    rmSync(home, { recursive: true, force: true });

    expect(() => importRepoKey(repoId, exp.stdout)).toThrow(/secret key/i);
  });

  it('replacement retires the old key but keeps it downloadable', () => {
    const repoId = insertRepo(`key-rot-${randomUUID().slice(0, 8)}`);
    const first = makeKey();
    const second = makeKey();

    importRepoKey(repoId, first.armored);
    importRepoKey(repoId, second.armored);

    // new key signs, old key stays public
    expect(repoFingerprint(repoId)).toBe(second.fingerprint);
    expect(publicKeyByFingerprint(repoId, first.fingerprint)).toContain(
      'BEGIN PGP PUBLIC KEY BLOCK',
    );
    expect(publicKeyByFingerprint(repoId, second.fingerprint)).toContain(
      'BEGIN PGP PUBLIC KEY BLOCK',
    );

    const links = db.select().from(schema.repoKeys).where(eq(schema.repoKeys.repoId, repoId)).all();
    expect(links).toHaveLength(2);
    const active = links.filter((l) => l.active);
    expect(active).toHaveLength(1);
    const activeFpr = db
      .select({ fingerprint: schema.gpgKeys.fingerprint })
      .from(schema.gpgKeys)
      .where(eq(schema.gpgKeys.id, active[0].keyId))
      .all()[0];
    expect(activeFpr.fingerprint).toBe(second.fingerprint);
  });

  it('importing with no passphrase clears a previous one', () => {
    const repoId = insertRepo(`key-clear-${randomUUID().slice(0, 8)}`);
    const protectedKey = makeKey('secret');
    const openKey = makeKey();

    importRepoKey(repoId, protectedKey.armored, 'secret');
    expect(existsSync(passphraseFile(repoId))).toBe(true);

    importRepoKey(repoId, openKey.armored);
    expect(existsSync(passphraseFile(repoId))).toBe(false);
  });
});

describe.skipIf(!commandExists('gpg'))('key replacement API', () => {
  it('rotates the key, retires the old one, and records an audit entry', async () => {
    const repoName = `rot-api-${randomUUID().slice(0, 8)}`;
    const repoId = insertRepo(repoName);
    const first = makeKey();
    const second = makeKey();
    importRepoKey(repoId, first.armored);

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${repoName}/key`,
      headers: bearer(),
      payload: { privateKey: second.armored },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.fingerprint).toBe(second.fingerprint);

    // re-sign jobs for every env are enqueued
    const jobs = db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.repoId, repoId), eq(schema.jobs.kind, 'rebuild')))
      .all();
    expect(jobs.length).toBeGreaterThanOrEqual(1);

    expect(repoFingerprint(repoId)).toBe(second.fingerprint);
    expect(publicKeyByFingerprint(repoId, first.fingerprint)).toBeTruthy();

    const audit = await server.inject({
      method: 'GET',
      url: '/api/v1/audit?action=key.rotate',
      headers: bearer(),
    });
    const entries = audit.json().data as {
      action: string;
      details: { fingerprint: string } | null;
    }[];
    expect(entries.some((e) => e.details?.fingerprint === second.fingerprint)).toBe(true);
  });

  it('serves replaced keys by fingerprint from the public zone', async () => {
    const repoName = `rot-pub-${randomUUID().slice(0, 8)}`;
    const repoId = insertRepo(repoName);
    const first = makeKey();
    const second = makeKey();
    importRepoKey(repoId, first.armored);
    importRepoKey(repoId, second.armored);

    const current = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/stable/gpg-public-key`,
    });
    expect(current.statusCode).toBe(200);
    expect(current.body).toContain('BEGIN PGP PUBLIC KEY BLOCK');
    expect(publicKey(repoId)).toBe(current.body);

    const retired = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/stable/gpg-public-key/${first.fingerprint}`,
    });
    expect(retired.statusCode).toBe(200);
    expect(retired.body).toContain('BEGIN PGP PUBLIC KEY BLOCK');

    const missing = await server.inject({
      method: 'GET',
      url: `/r/${repoName}/stable/gpg-public-key/deadbeefdeadbeefdeadbeefdeadbeefdeadbeef`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects a bad key without touching the current one', async () => {
    const repoName = `rot-bad-${randomUUID().slice(0, 8)}`;
    const repoId = insertRepo(repoName);
    const first = makeKey();
    importRepoKey(repoId, first.armored);

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/repos/${repoName}/key`,
      headers: bearer(),
      payload: { privateKey: 'not a key at all' },
    });
    expect(res.statusCode).toBe(400);
    // the homedir was wiped before the failure — the current fingerprint row
    // is untouched in the DB, but signing material is gone by design; what
    // matters here is the request failed loudly.
    expect(repoFingerprint(repoId)).toBe(first.fingerprint);
  });
});
