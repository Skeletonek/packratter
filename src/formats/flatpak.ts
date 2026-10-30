import { createHash } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  existsSync,
  rmSync,
  mkdtempSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureRepoEnvDir } from '../lib/paths.js';
import { run } from '../lib/exec.js';
import { gpgHome, repoFingerprint } from '../gpg/index.js';
import { config } from '../config.js';
import type { EnvRef, PackageMeta, ValidationResult } from './types.js';

function flatpakDir(env: EnvRef): string {
  return join(ensureRepoEnvDir(env.repoId, env.id), 'flatpak');
}

function ostreeRepo(env: EnvRef): string {
  return join(flatpakDir(env), 'ostree');
}

function bundlesDir(env: EnvRef): string {
  return join(flatpakDir(env), 'bundles');
}

function safeFilename(ref: string): string {
  return `${ref.replace(/[^a-zA-Z0-9._-]/g, '_')}.flatpak`;
}

function ensureOstreeRepo(env: EnvRef): void {
  const repo = ostreeRepo(env);
  if (existsSync(join(repo, 'config'))) return;
  mkdirSync(repo, { recursive: true });
  const init = spawnSync('ostree', ['init', '--repo', repo, '--mode', 'archive-z2'], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (init.status !== 0) {
    throw new Error(`ostree init failed: ${init.stderr}`);
  }
}

export function validate(tmpPath: string): ValidationResult {
  const base = mkdtempSync(join(config.DATA_DIR, 'tmp', 'flatpak-validate-'));
  const repo = join(base, 'repo');
  try {
    mkdirSync(repo, { recursive: true });
    const init = spawnSync('ostree', ['init', '--repo', repo, '--mode', 'archive-z2'], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    if (init.status !== 0) {
      return { ok: false, error: `ostree init failed: ${init.stderr}` };
    }
    const importBundle = spawnSync('flatpak', ['build-import-bundle', repo, tmpPath], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    if (importBundle.status !== 0) {
      return { ok: false, error: importBundle.stderr || 'not a valid flatpak bundle' };
    }
    return { ok: true };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

export function ingest(env: EnvRef, tmpPath: string, bytes: Buffer): PackageMeta {
  ensureOstreeRepo(env);
  const repo = ostreeRepo(env);

  const importBundle = spawnSync('flatpak', ['build-import-bundle', repo, tmpPath], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (importBundle.status !== 0) {
    throw new Error(`flatpak build-import-bundle failed: ${importBundle.stderr}`);
  }

  const match = importBundle.stdout.match(/Importing\s+(\S+)/);
  const ref = match?.[1] ?? '';
  if (!ref) {
    throw new Error('could not determine flatpak ref from bundle import');
  }

  mkdirSync(bundlesDir(env), { recursive: true });
  const filename = safeFilename(ref);
  const dest = join(bundlesDir(env), filename);
  renameSync(tmpPath, dest);

  return {
    filename,
    version: null,
    arch: null,
    ref,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function removePackage(
  env: EnvRef,
  pkg: { filename: string; arch: string | null; ref: string | null },
): void {
  const bundlePath = join(bundlesDir(env), pkg.filename);
  try {
    unlinkSync(bundlePath);
  } catch {}

  if (pkg.ref) {
    const repo = ostreeRepo(env);
    const del = spawnSync('ostree', ['refs', '--repo', repo, '--delete', pkg.ref], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    if (del.status !== 0) {
      throw new Error(`ostree refs --delete failed: ${del.stderr}`);
    }
  }
}

export function promote(
  src: EnvRef,
  dst: EnvRef,
  pkg: { filename: string; arch: string | null; ref: string | null },
): void {
  const dest = join(bundlesDir(dst), pkg.filename);
  mkdirSync(bundlesDir(dst), { recursive: true });
  linkSync(join(bundlesDir(src), pkg.filename), dest);

  // Ostree content cannot be hardlinked across repos, so the bundle is
  // re-imported into the target env's ostree repo.
  ensureOstreeRepo(dst);
  const importBundle = spawnSync('flatpak', ['build-import-bundle', ostreeRepo(dst), dest], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (importBundle.status !== 0) {
    throw new Error(`flatpak build-import-bundle failed: ${importBundle.stderr}`);
  }
}

async function signAllCommits(
  env: EnvRef,
  fingerprint: string,
  log: (line: string) => void,
): Promise<void> {
  const repo = ostreeRepo(env);
  const refs = await run('ostree', ['refs', '--repo', repo], {
    env: { ...process.env, LC_ALL: 'C' },
  });

  for (const ref of refs.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)) {
    const rev = await run('ostree', ['rev-parse', '--repo', repo, ref], {
      env: { ...process.env, LC_ALL: 'C' },
    });
    const commit = rev.stdout.trim();
    await run(
      'ostree',
      ['gpg-sign', '--repo', repo, '--gpg-homedir', gpgHome(env.repoId), commit, fingerprint],
      { env: { ...process.env, LC_ALL: 'C' } },
      log,
    );
  }
}

export async function rebuild(env: EnvRef, log: (line: string) => void): Promise<void> {
  const repo = ostreeRepo(env);
  ensureOstreeRepo(env);

  const fingerprint = repoFingerprint(env.repoId);
  if (!fingerprint) {
    throw new Error('repo has no signing key');
  }

  await signAllCommits(env, fingerprint, log);

  await run(
    'flatpak',
    ['build-update-repo', '--gpg-sign', fingerprint, '--gpg-homedir', gpgHome(env.repoId), repo],
    { env: { ...process.env, LC_ALL: 'C' } },
    log,
  );
}

export function serveHeaders(path: string): Record<string, string> {
  const base = basename(path);
  if (base === 'summary' || base === 'summary.sig') {
    return { 'cache-control': 'no-cache' };
  }
  if (path.includes('/objects/')) {
    return { 'cache-control': 'max-age=31536000, immutable' };
  }
  return { 'cache-control': 'no-cache' };
}

export function setupSnippet(
  repoName: string,
  baseUrl: string,
  envName: string,
  _fingerprint: string,
): string {
  return `keyfile=$(mktemp)
curl -fsSL ${baseUrl}/api/v1/repos/${repoName}/${envName}/gpg-public-key -o "$keyfile"
flatpak remote-add --user --gpg-import="$keyfile" ${repoName} ${baseUrl}/r/${repoName}/${envName}/flatpak/ostree/
rm -f "$keyfile"

# Replace <app-id> with the application you want to install
flatpak install --user ${repoName} <app-id>
`;
}
