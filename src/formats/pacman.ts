import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { ensureRepoEnvDir, repoEnvDir } from '../lib/paths.js';
import { run } from '../lib/exec.js';
import { detachSign, gpgHome, repoFingerprint } from '../gpg/index.js';
import type { EnvRef, PackageMeta, ValidationResult } from './types.js';

function detectExtension(bytes: Buffer): string {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x28 &&
    bytes[1] === 0xb5 &&
    bytes[2] === 0x2f &&
    bytes[3] === 0xfd
  ) {
    return '.pkg.tar.zst';
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0xfd &&
    bytes[1] === 0x37 &&
    bytes[2] === 0x7a &&
    bytes[3] === 0x58 &&
    bytes[4] === 0x5a &&
    bytes[5] === 0x00
  ) {
    return '.pkg.tar.xz';
  }
  return '.pkg.tar.zst';
}

function readPkginfo(path: string): Record<string, string> {
  const result = spawnSync('bsdtar', ['-xOf', path, '.PKGINFO'], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.status !== 0) {
    throw new Error(`could not read .PKGINFO: ${result.stderr}`);
  }
  const info: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      info[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return info;
}

export function validate(tmpPath: string): ValidationResult {
  const check = spawnSync('bsdtar', ['-tqf', tmpPath, '.PKGINFO'], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (check.status !== 0) {
    return { ok: false, error: 'not a valid pacman package' };
  }
  return { ok: true };
}

export function ingest(env: EnvRef, tmpPath: string, bytes: Buffer): PackageMeta {
  const info = readPkginfo(tmpPath);
  const { pkgname, pkgver, pkgrel, arch } = info;
  if (!pkgname || !pkgver || !arch) {
    throw new Error('missing required .PKGINFO fields');
  }

  // .PKGINFO carries the combined pkgver-pkgrel (e.g. "2.4.0-1"); fold in a
  // legacy separate pkgrel when present so the filename stays name-ver-rel-arch.
  const version = pkgrel && !pkgver.endsWith(`-${pkgrel}`) ? `${pkgver}-${pkgrel}` : pkgver;

  const ext = detectExtension(bytes);
  const filename = `${pkgname}-${version}-${arch}${ext}`;
  const dir = ensureRepoEnvDir(env.repoId, env.id);
  const dest = join(dir, filename);

  mkdirSync(dirname(tmpPath), { recursive: true });
  renameSync(tmpPath, dest);

  return {
    filename,
    version,
    arch,
    ref: null,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function removePackage(
  env: EnvRef,
  pkg: { filename: string; arch: string | null; ref: string | null },
): void {
  try {
    unlinkSync(join(repoEnvDir(env.repoId, env.id), pkg.filename));
  } catch {}
}

export function promote(
  src: EnvRef,
  dst: EnvRef,
  pkg: { filename: string; arch: string | null; ref: string | null },
): void {
  linkSync(
    join(repoEnvDir(src.repoId, src.id), pkg.filename),
    join(ensureRepoEnvDir(dst.repoId, dst.id), pkg.filename),
  );
}

export async function rebuild(env: EnvRef, log: (line: string) => void): Promise<void> {
  const dir = repoEnvDir(env.repoId, env.id);
  const repo = db.select().from(schema.repos).where(eq(schema.repos.id, env.repoId)).all()[0];
  if (!repo) {
    throw new Error('repo not found');
  }

  const pkgs = db.select().from(schema.packages).where(eq(schema.packages.envId, env.id)).all();

  if (pkgs.length === 0) {
    for (const name of [repo.name, `${repo.name}.files`]) {
      for (const suffix of ['', '.sig']) {
        try {
          unlinkSync(join(dir, `${name}.tar.gz${suffix}`));
        } catch {}
        try {
          unlinkSync(join(dir, `${name}.db${suffix}`));
        } catch {}
      }
    }
    return;
  }

  const fingerprint = repoFingerprint(env.repoId);
  if (!fingerprint) {
    throw new Error('repo has no signing key');
  }

  const gpgEnv = { ...process.env, LC_ALL: 'C', GNUPGHOME: gpgHome(env.repoId) };

  await run(
    'repo-add',
    [`${repo.name}.db.tar.gz`, ...pkgs.map((p) => p.filename)],
    { cwd: dir, env: gpgEnv },
    log,
  );

  const signFile = async (name: string) => {
    await detachSign(env.repoId, fingerprint, join(dir, name), join(dir, `${name}.sig`), log);
  };

  await signFile(`${repo.name}.db`);
  await signFile(`${repo.name}.files`);
  for (const pkg of pkgs) {
    await signFile(pkg.filename);
  }
}

export function serveHeaders(path: string): Record<string, string> {
  const base = basename(path);
  if (
    base.endsWith('.db') ||
    base.endsWith('.db.sig') ||
    base.endsWith('.files') ||
    base.endsWith('.files.sig') ||
    base.endsWith('.sig')
  ) {
    return { 'cache-control': 'no-cache' };
  }
  if (base.endsWith('.pkg.tar.zst') || base.endsWith('.pkg.tar.xz')) {
    return { 'cache-control': 'max-age=31536000, immutable' };
  }
  return { 'cache-control': 'no-cache' };
}

export function setupSnippet(
  repoName: string,
  baseUrl: string,
  envName: string,
  fingerprint: string,
): string {
  return `keyfile=$(mktemp)
curl -fsSL ${baseUrl}/api/v1/repos/${repoName}/${envName}/gpg-public-key -o "$keyfile"
sudo pacman-key --add "$keyfile"
rm -f "$keyfile"
sudo pacman-key --lsign-key ${fingerprint}

[${repoName}]
Server = ${baseUrl}/r/${repoName}/${envName}
SigLevel = Required DatabaseOptional
`;
}
