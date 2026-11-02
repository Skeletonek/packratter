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
import type { EnvRef, PackageMeta, RefRename, ValidationResult } from './types.js';

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

// A bundle's commit carries a ref binding fixed when it was built (usually
// "master"); flatpak verifies it on pull, so renaming a branch requires
// build-commit-from, which creates a new commit with the binding rewritten.
// `--force` replaces an existing target ref, i.e. a re-upload of the app.
function importBundle(
  envName: string | null,
  repo: string,
  bundlePath: string,
  spawnOpts: { encoding: 'utf8'; env: NodeJS.ProcessEnv },
): string {
  const importOp = spawnSync('flatpak', ['build-import-bundle', repo, bundlePath], spawnOpts);
  if (importOp.status !== 0) {
    throw new Error(`flatpak build-import-bundle failed: ${importOp.stderr}`);
  }
  const ref = importOp.stdout.match(/Importing\s+(\S+)/)?.[1] ?? '';
  if (!ref) {
    throw new Error('could not determine flatpak ref from bundle import');
  }

  if (!envName || ref.split('/').length !== 4) return ref;
  const reBranched = reBranchRef(ref, envName);
  if (reBranched === null || reBranched === ref) return ref;

  const commit = spawnSync(
    'flatpak',
    ['build-commit-from', '--force', `--src-repo=${repo}`, `--src-ref=${ref}`, repo, reBranched],
    spawnOpts,
  );
  if (commit.status !== 0) {
    throw new Error(`flatpak build-commit-from failed: ${commit.stderr}`);
  }
  const stale = spawnSync('ostree', ['refs', '--repo', repo, '--delete', ref], spawnOpts);
  if (stale.status !== 0) {
    throw new Error(`ostree refs --delete failed: ${stale.stderr}`);
  }
  return reBranched;
}

export function ingest(env: EnvRef, tmpPath: string, bytes: Buffer): PackageMeta {
  ensureOstreeRepo(env);
  const repo = ostreeRepo(env);
  const spawnOpts = { encoding: 'utf8' as const, env: { ...process.env, LC_ALL: 'C' } };

  const effectiveRef = importBundle(
    env.branchMode === 'bundle' ? null : env.name,
    repo,
    tmpPath,
    spawnOpts,
  );
  const parts = effectiveRef.split('/');

  // App version lives only in the appstream metainfo shipped inside the
  // bundle (nothing summary-side is generated before the first rebuild).
  let version: string | null = null;
  if (parts.length === 4) {
    version = metainfoVersion(repo, effectiveRef, parts[1]);
  }

  mkdirSync(bundlesDir(env), { recursive: true });
  const filename = safeFilename(effectiveRef);
  const dest = join(bundlesDir(env), filename);
  renameSync(tmpPath, dest);

  return {
    filename,
    version,
    arch: parts.length === 4 ? parts[2] : null,
    ref: effectiveRef,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function metainfoVersion(repo: string, ref: string, appId: string): string | null {
  const locations = [
    `/files/share/metainfo/${appId}.metainfo.xml`,
    `/files/share/appdata/${appId}.appdata.xml`,
  ];
  for (const location of locations) {
    const cat = spawnSync('ostree', ['cat', '--repo', repo, ref, location], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    if (cat.status === 0) {
      return cat.stdout.match(/<release\b[^>]*\bversion="([^"]+)"/)?.[1] ?? null;
    }
  }
  return null;
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
  const spawnOpts = { encoding: 'utf8' as const, env: { ...process.env, LC_ALL: 'C' } };
  const ref = importBundle(
    dst.branchMode === 'bundle' ? null : dst.name,
    ostreeRepo(dst),
    dest,
    spawnOpts,
  );
  // The caller inserts the promoted row straight from this object, so
  // pkg.ref must end up identical to the ostree ref the bundle lands on.
  pkg.ref = ref;
}

function reBranchRef(ref: string, branch: string): string | null {
  const parts = ref.split('/');
  if (parts.length !== 4) return null;
  return `${parts[0]}/${parts[1]}/${parts[2]}/${branch}`;
}

export function renameEnv(env: EnvRef, newName: string): RefRename[] {
  if (env.branchMode === 'bundle') return [];
  const repo = ostreeRepo(env);
  const spawnOpts = { encoding: 'utf8' as const, env: { ...process.env, LC_ALL: 'C' } };
  const refs = spawnSync('ostree', ['refs', '--repo', repo], spawnOpts);
  if (refs.status !== 0) {
    throw new Error(`ostree refs failed: ${refs.stderr}`);
  }

  const listed = refs.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const toRename = listed.filter(
    (ref) => ref.split('/').length === 4 && ref.split('/')[3] === env.name,
  );
  if (toRename.length === 0) return [];

  const renames: RefRename[] = toRename.map((oldRef) => ({
    oldRef,
    newRef: reBranchRef(oldRef, newName)!,
  }));
  // Refuse before touching anything so a failed rename leaves the repo usable.
  for (const { newRef } of renames) {
    if (listed.includes(newRef)) {
      throw new Error(`flatpak branch ${newRef} already exists; renaming would overwrite it`);
    }
  }

  for (const { oldRef, newRef } of renames) {
    const commit = spawnSync(
      'flatpak',
      ['build-commit-from', '--force', `--src-repo=${repo}`, `--src-ref=${oldRef}`, repo, newRef],
      spawnOpts,
    );
    if (commit.status !== 0) {
      throw new Error(`flatpak build-commit-from failed: ${commit.stderr}`);
    }
    const old = spawnSync('ostree', ['refs', '--repo', repo, '--delete', oldRef], spawnOpts);
    if (old.status !== 0) {
      throw new Error(`ostree refs --delete failed: ${old.stderr}`);
    }
  }
  return renames;
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
curl -fsSL ${baseUrl}/r/${repoName}/${envName}/gpg-public-key -o "$keyfile"
flatpak remote-add --user --gpg-import="$keyfile" ${repoName} ${baseUrl}/r/${repoName}/${envName}/flatpak/ostree/
rm -f "$keyfile"

# Replace <app-id> with the application you want to install
flatpak install --user ${repoName} <app-id>
`;
}
