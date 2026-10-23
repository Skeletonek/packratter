import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureRepoEnvDir } from '../lib/paths.js';
import { gpgHome, repoFingerprint } from '../gpg/index.js';
import { config } from '../config.js';

export interface FlatpakMeta {
  filename: string;
  ref: string;
  size: number;
  sha256: string;
}

function flatpakDir(env: { repoId: string; id: string }): string {
  return join(ensureRepoEnvDir(env.repoId, env.id), 'flatpak');
}

function ostreeRepo(env: { repoId: string; id: string }): string {
  return join(flatpakDir(env), 'ostree');
}

function bundlesDir(env: { repoId: string; id: string }): string {
  return join(flatpakDir(env), 'bundles');
}

function safeFilename(ref: string): string {
  return `${ref.replace(/[^a-zA-Z0-9._-]/g, '_')}.flatpak`;
}

function ensureOstreeRepo(env: { repoId: string; id: string }): void {
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

export function validate(tmpPath: string): { ok: true } | { ok: false; error: string } {
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

export function ingest(
  env: { id: string; repoId: string; name: string },
  tmpPath: string,
  bytes: Buffer,
): FlatpakMeta {
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
    ref,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function removeBundle(
  env: { id: string; repoId: string; name: string },
  pkg: { filename: string; ref: string | null },
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

function signAllCommits(
  env: { id: string; repoId: string; name: string },
  fingerprint: string,
  log: (line: string) => void,
): void {
  const repo = ostreeRepo(env);
  const refs = spawnSync('ostree', ['refs', '--repo', repo], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (refs.status !== 0) {
    throw new Error(`ostree refs failed: ${refs.stderr}`);
  }

  for (const ref of refs.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const rev = spawnSync('ostree', ['rev-parse', '--repo', repo, ref], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    if (rev.status !== 0) {
      throw new Error(`ostree rev-parse failed: ${rev.stderr}`);
    }
    const commit = rev.stdout.trim();
    const sign = spawnSync(
      'ostree',
      ['gpg-sign', '--repo', repo, '--gpg-homedir', gpgHome(env.repoId), commit, fingerprint],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
      },
    );
    if (sign.stdout) log(sign.stdout);
    if (sign.stderr) log(sign.stderr);
    if (sign.status !== 0) {
      throw new Error(`ostree gpg-sign failed for ${ref}: ${sign.stderr}`);
    }
  }
}

export function rebuild(
  env: { id: string; repoId: string; name: string },
  log: (line: string) => void,
): void {
  const repo = ostreeRepo(env);
  ensureOstreeRepo(env);

  const fingerprint = repoFingerprint(env.repoId);
  if (!fingerprint) {
    throw new Error('repo has no signing key');
  }

  signAllCommits(env, fingerprint, log);

  const update = spawnSync(
    'flatpak',
    ['build-update-repo', '--gpg-sign', fingerprint, '--gpg-homedir', gpgHome(env.repoId), repo],
    {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    },
  );
  if (update.stdout) log(update.stdout);
  if (update.stderr) log(update.stderr);
  if (update.status !== 0) {
    throw new Error(`flatpak build-update-repo failed with code ${update.status}`);
  }
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
  repoId: string,
  repoName: string,
  baseUrl: string,
  envName: string,
  _fingerprint: string,
): string {
  return `keyfile=$(mktemp)
curl -fsSL ${baseUrl}/api/v1/repos/${repoId}/${envName}/gpg-public-key -o "$keyfile"
flatpak remote-add --user --gpg-import="$keyfile" ${repoName} ${baseUrl}/r/${repoId}/${envName}/flatpak/ostree/
rm -f "$keyfile"

# Replace <app-id> with the application you want to install
flatpak install --user ${repoName} <app-id>
`;
}
