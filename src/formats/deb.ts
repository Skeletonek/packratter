import { createHash, randomUUID } from 'node:crypto';
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
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { ensureRepoEnvDir, repoEnvDir } from '../lib/paths.js';
import { clearSign, detachSign, repoFingerprint } from '../gpg/index.js';
import type { EnvRef, PackageMeta, ValidationResult } from './types.js';

const COMPONENT = 'main';

function debDir(env: EnvRef): string {
  return join(ensureRepoEnvDir(env.repoId, env.id), 'deb');
}

function debRoot(env: EnvRef): string {
  return join(repoEnvDir(env.repoId, env.id), 'deb');
}

function safeFilename(text: string): string {
  return text.replace(/[^a-zA-Z0-9.+~_-]/g, '_');
}

function readMagic(path: string, length: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function readControl(tmpPath: string): { pkg: string; version: string; arch: string } {
  const result = spawnSync('dpkg-deb', ['-f', tmpPath, 'Package', 'Version', 'Architecture'], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.status !== 0) {
    throw new Error(`dpkg-deb failed: ${result.stderr || result.status}`);
  }
  // Output is one "Field: value" line per requested field; strip the label.
  const [pkg = '', version = '', arch = ''] = result.stdout
    .split('\n')
    .map((line) => line.replace(/^[A-Za-z-]+: /, '').trim());
  if (!pkg || !version || !arch) {
    throw new Error('missing required control fields');
  }
  return { pkg, version, arch };
}

function writeAtomic(path: string, data: Buffer | string): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function validate(tmpPath: string): ValidationResult {
  if (readMagic(tmpPath, 8).toString('latin1') !== '!<arch>\n') {
    return { ok: false, error: 'not a valid Debian package' };
  }
  try {
    readControl(tmpPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export function ingest(env: EnvRef, tmpPath: string, bytes: Buffer): PackageMeta {
  const { pkg, version, arch } = readControl(tmpPath);
  const filename = `${safeFilename(pkg)}_${safeFilename(version.replace(/^[0-9]+:/, ''))}_${safeFilename(arch)}.deb`;

  const poolDir = join(debDir(env), 'pool', safeFilename(arch));
  mkdirSync(poolDir, { recursive: true });
  renameSync(tmpPath, join(poolDir, filename));

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
  if (!pkg.arch) return;
  try {
    unlinkSync(join(debRoot(env), 'pool', safeFilename(pkg.arch), pkg.filename));
  } catch {}
}

function packagesFor(root: string, dirs: string[]): string {
  const stanzas: string[] = [];
  for (const dir of dirs) {
    const result = spawnSync('apt-ftparchive', ['packages', dir], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    if (result.status !== 0) {
      throw new Error(`apt-ftparchive packages failed: ${result.stderr || result.status}`);
    }
    if (result.stdout.trim()) stanzas.push(result.stdout.trimEnd());
  }
  return stanzas.length > 0 ? `${stanzas.join('\n')}\n` : '';
}

export function rebuild(env: EnvRef, log: (line: string) => void): void {
  const root = debDir(env);
  const poolDir = join(root, 'pool');
  const distsDir = join(root, 'dists', env.name);

  const archs = existsSync(poolDir)
    ? readdirSync(poolDir).filter((entry) => {
        try {
          return readdirSync(join(poolDir, entry)).some((f) => f.endsWith('.deb'));
        } catch {
          return false;
        }
      })
    : [];

  if (archs.length === 0) {
    rmSync(join(root, 'dists'), { recursive: true, force: true });
    return;
  }

  const hasAll = archs.includes('all');
  for (const arch of archs) {
    const dirs = arch === 'all' ? ['pool/all'] : [`pool/${arch}`, ...(hasAll ? ['pool/all'] : [])];
    const packages = packagesFor(root, dirs);
    const outDir = join(distsDir, COMPONENT, `binary-${arch}`);
    mkdirSync(outDir, { recursive: true });
    writeAtomic(join(outDir, 'Packages'), packages);
    writeAtomic(join(outDir, 'Packages.gz'), gzipSync(Buffer.from(packages)));
    log(`wrote main/binary-${arch}/Packages`);
  }

  const confPath = join(root, `.ftparchive-${randomUUID()}.conf`);
  writeFileSync(
    confPath,
    `APT::FTPArchive::Release {
  Origin "Packratter";
  Label "Packratter";
  Suite "${env.name}";
  Codename "${env.name}";
  Components "${COMPONENT}";
  Architectures "${archs.join(' ')}";
};
`,
  );
  let release: string;
  try {
    const result = spawnSync('apt-ftparchive', ['-c', confPath, 'release', distsDir], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    if (result.stdout) log(result.stdout);
    if (result.stderr) log(result.stderr);
    if (result.status !== 0) {
      throw new Error(`apt-ftparchive release failed with code ${result.status}`);
    }
    release = result.stdout;
  } finally {
    rmSync(confPath, { force: true });
  }
  writeAtomic(join(distsDir, 'Release'), release);

  const fingerprint = repoFingerprint(env.repoId);
  if (!fingerprint) {
    throw new Error('repo has no signing key');
  }
  clearSign(env.repoId, fingerprint, join(distsDir, 'Release'), join(distsDir, 'InRelease'), log);
  detachSign(
    env.repoId,
    fingerprint,
    join(distsDir, 'Release'),
    join(distsDir, 'Release.gpg'),
    log,
    true,
  );
}

export function serveHeaders(path: string): Record<string, string> {
  if (path.includes('/pool/')) {
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
  return `curl -fsSL ${baseUrl}/api/v1/repos/${repoId}/${envName}/gpg-public-key \\
  | sudo gpg --dearmor -o /usr/share/keyrings/${repoName}.gpg

echo "deb [signed-by=/usr/share/keyrings/${repoName}.gpg] ${baseUrl}/r/${repoId}/${envName}/deb ${envName} main" \\
  | sudo tee /etc/apt/sources.list.d/${repoName}.list
sudo apt-get update

# Replace <package> with the package you want to install
sudo apt-get install <package>
`;
}
