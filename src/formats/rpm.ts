import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureRepoEnvDir, repoEnvDir } from '../lib/paths.js';
import { detachSign, repoFingerprint } from '../gpg/index.js';
import type { EnvRef, PackageMeta, ValidationResult } from './types.js';

function rpmDir(env: EnvRef): string {
  return join(ensureRepoEnvDir(env.repoId, env.id), 'rpm');
}

function rpmRoot(env: EnvRef): string {
  return join(repoEnvDir(env.repoId, env.id), 'rpm');
}

function safeFilename(text: string): string {
  return text.replace(/[^a-zA-Z0-9.+~_-]/g, '_');
}

function hasRpmMagic(tmpPath: string): boolean {
  const fd = openSync(tmpPath, 'r');
  try {
    const buf = Buffer.alloc(4);
    const read = readSync(fd, buf, 0, 4, 0);
    return read === 4 && buf[0] === 0xed && buf[1] === 0xab && buf[2] === 0xee && buf[3] === 0xdb;
  } finally {
    closeSync(fd);
  }
}

function readRpmMeta(tmpPath: string): { name: string; version: string; arch: string } {
  const result = spawnSync(
    'rpm',
    ['-qp', '--qf', '%{NAME}\n%{VERSION}-%{RELEASE}\n%{ARCH}\n', tmpPath],
    {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    },
  );
  if (result.status !== 0) {
    throw new Error(`rpm -qp failed: ${result.stderr || result.status}`);
  }
  const [name = '', version = '', arch = ''] = result.stdout.split('\n').map((line) => line.trim());
  if (!name || !version || !arch) {
    throw new Error('missing required rpm metadata');
  }
  return { name, version, arch };
}

export function validate(tmpPath: string): ValidationResult {
  if (!hasRpmMagic(tmpPath)) {
    return { ok: false, error: 'not a valid RPM package' };
  }
  try {
    readRpmMeta(tmpPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export function ingest(env: EnvRef, tmpPath: string, bytes: Buffer): PackageMeta {
  const { name, version, arch } = readRpmMeta(tmpPath);
  const filename = `${safeFilename(name)}-${safeFilename(version)}.${safeFilename(arch)}.rpm`;

  const packagesDir = join(rpmDir(env), 'packages');
  mkdirSync(packagesDir, { recursive: true });
  renameSync(tmpPath, join(packagesDir, filename));

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
    unlinkSync(join(rpmRoot(env), 'packages', pkg.filename));
  } catch {}
}

export function rebuild(env: EnvRef, log: (line: string) => void): void {
  const root = rpmDir(env);
  const packagesDir = join(root, 'packages');
  const hasPackages =
    existsSync(packagesDir) && readdirSync(packagesDir).some((f) => f.endsWith('.rpm'));

  if (!hasPackages) {
    rmSync(join(root, 'repodata'), { recursive: true, force: true });
    return;
  }

  const result = spawnSync('createrepo_c', ['--update', '--general-compress-type=zstd', root], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.stdout) log(result.stdout);
  if (result.stderr) log(result.stderr);
  if (result.status !== 0) {
    throw new Error(`createrepo_c failed with code ${result.status}`);
  }

  const fingerprint = repoFingerprint(env.repoId);
  if (!fingerprint) {
    throw new Error('repo has no signing key');
  }
  detachSign(
    env.repoId,
    fingerprint,
    join(root, 'repodata', 'repomd.xml'),
    join(root, 'repodata', 'repomd.xml.asc'),
    log,
    true,
  );
}

export function serveHeaders(path: string): Record<string, string> {
  if (path.endsWith('.rpm')) {
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
  return `sudo tee /etc/yum.repos.d/${repoName}.repo > /dev/null <<EOF
[${repoName}]
name=${repoName}
baseurl=${baseUrl}/r/${repoId}/${envName}/rpm
enabled=1
gpgcheck=0
repo_gpgcheck=1
gpgkey=${baseUrl}/api/v1/repos/${repoId}/${envName}/gpg-public-key
EOF

sudo dnf makecache --refresh

# Replace <package> with the package you want to install
sudo dnf install <package>
`;
}
