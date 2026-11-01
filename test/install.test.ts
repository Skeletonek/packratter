import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { generateToken } from '../src/auth/tokens.js';
import { applyMigrations, db } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { buildServer } from '../src/server.js';
import {
  buildDebPackage,
  buildFlatpakBundle,
  buildPacmanPackage,
  buildRpmPackage,
  commandExists,
} from './helpers.js';

// Real client installs against a real listening server. Everything lives in a
// throwaway temp dir (including flatpak's user state), so the host is never
// touched. The full matrix runs in the toolchain container via
// docker-compose.test.yml; locally, whichever clients exist run.

const full = process.env.RUN_FULL_TESTS === '1';
const isRoot = (process.getuid?.() ?? 0) === 0;

let token = '';
let server: FastifyInstance;
let baseUrl = '';

function auth(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// Async spawn: the server runs in this process, so a synchronous child would
// block its event loop and deadlock any client fetching from it.
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, LC_ALL: 'C', ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));
    child.on('error', (err) => resolve({ status: -1, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

function expectOk(result: { status: number; stdout: string; stderr: string }, label: string): void {
  expect(result.status, `${label} failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
}

// Retry once on network errors: long client runs can outlive idle sockets.
async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    return await fetch(url, init);
  }
}

async function waitForJobHttp(jobId: string): Promise<{ status: string; log: string }> {
  let job: { status: string; log: string } | null = null;
  for (let i = 0; i < 120; i++) {
    const res = await fetchRetry(`${baseUrl}/api/v1/jobs/${jobId}`, { headers: auth() });
    job = (await res.json()).data;
    if (job?.status === 'done' || job?.status === 'error') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!job) throw new Error(`job ${jobId} not found`);
  return job;
}

async function createRepo(name: string, type: string): Promise<void> {
  const res = await fetchRetry(`${baseUrl}/api/v1/repos`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type }),
  });
  expect(res.status).toBe(201);
}

async function upload(name: string, bytes: Buffer): Promise<void> {
  const res = await fetchRetry(`${baseUrl}/api/v1/repos/${name}/stable/packages`, {
    method: 'PUT',
    headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  expect(res.status).toBe(202);
  const job = await waitForJobHttp((await res.json()).data.jobId);
  expect(job.status, `rebuild failed:\n${job.log}`).toBe('done');
}

async function fetchKey(name: string): Promise<string> {
  const res = await fetchRetry(`${baseUrl}/r/${name}/stable/gpg-public-key`);
  expect(res.status).toBe(200);
  return res.text();
}

async function gpgFingerprint(keyFile: string): Promise<string> {
  const res = await run('gpg', [
    '--batch',
    '--with-colons',
    '--import-options',
    'show-only',
    '--import',
    keyFile,
  ]);
  const line = res.stdout.split('\n').find((l) => l.startsWith('fpr:'));
  return line ? line.split(':')[9] : '';
}

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
  await server.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // Drop keep-alive sockets from fetch(), else close() waits for them.
  server.server.closeAllConnections();
  await server.close();
});

describe.skipIf(
  !full ||
    !isRoot ||
    !commandExists('pacman') ||
    !commandExists('pacman-key') ||
    !commandExists('repo-add') ||
    !commandExists('bsdtar') ||
    !commandExists('gpg'),
)('pacman client install (e2e)', () => {
  // pacman refuses sync operations for non-root even with --root, so this
  // block only runs as root (i.e. in the toolchain container).
  it('installs the package with verified signatures', async () => {
    const work = mkdtempSync(join(tmpdir(), 'packrat-e2e-pacman-'));
    try {
      await createRepo('e2e-pacman', 'pacman');
      await upload('e2e-pacman', buildPacmanPackage('package-test', '0.12.0'));

      const keyFile = join(work, 'key.asc');
      writeFileSync(keyFile, await fetchKey('e2e-pacman'));

      const gpgDir = join(work, 'gnupg');
      mkdirSync(gpgDir, { mode: 0o700 });
      expectOk(await run('pacman-key', ['--gpgdir', gpgDir, '--init']), 'pacman-key --init');
      expectOk(await run('pacman-key', ['--gpgdir', gpgDir, '--add', keyFile]), 'pacman-key --add');
      const fpr = await gpgFingerprint(keyFile);
      expect(fpr).not.toBe('');
      expectOk(
        await run('pacman-key', ['--gpgdir', gpgDir, '--lsign-key', fpr]),
        'pacman-key --lsign-key',
      );

      const confFile = join(work, 'pacman.conf');
      writeFileSync(
        confFile,
        [
          '[options]',
          'Architecture = auto',
          `GPGDir = ${gpgDir}`,
          'SigLevel = Required DatabaseOptional',
          '',
          '[e2e-pacman]',
          `Server = ${baseUrl}/r/e2e-pacman/stable`,
          '',
        ].join('\n'),
      );

      const rootDir = join(work, 'root');
      const dbPath = join(rootDir, 'var', 'lib', 'pacman');
      mkdirSync(dbPath, { recursive: true });
      const client = ['--config', confFile, '--root', rootDir, '--dbpath', dbPath];
      expectOk(
        await run('pacman', [...client, '--noconfirm', '-Sy', 'package-test']),
        'pacman -Sy',
      );

      const query = await run('pacman', [...client, '-Q', 'package-test']);
      expectOk(query, 'pacman -Q');
      expect(query.stdout).toContain('package-test 0.12.0-1');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(
  !full ||
    !commandExists('apt-get') ||
    !commandExists('dpkg') ||
    !commandExists('dpkg-deb') ||
    !commandExists('apt-ftparchive') ||
    !commandExists('gpg'),
)('deb client install (e2e)', () => {
  it('apt verifies the signed repo and dpkg installs the package', async () => {
    const work = mkdtempSync(join(tmpdir(), 'packrat-e2e-deb-'));
    try {
      await createRepo('e2e-deb', 'deb');
      await upload('e2e-deb', buildDebPackage());

      // Sandboxed apt tree: no system lists, caches, or status are touched.
      const aptRoot = join(work, 'apt');
      mkdirSync(join(aptRoot, 'lists', 'partial'), { recursive: true });
      mkdirSync(join(aptRoot, 'archives', 'partial'), { recursive: true });
      writeFileSync(join(aptRoot, 'status'), '');

      const keyFile = join(work, 'key.asc');
      writeFileSync(keyFile, await fetchKey('e2e-deb'));
      const trusted = join(aptRoot, 'trusted.gpg');
      expectOk(
        await run('gpg', ['--batch', '--yes', '--dearmor', '-o', trusted, keyFile]),
        'gpg --dearmor',
      );
      writeFileSync(
        join(aptRoot, 'sources.list'),
        `deb [signed-by=${trusted}] ${baseUrl}/r/e2e-deb/stable/deb stable main\n`,
      );

      const aptOpts = [
        '-o',
        `Dir::State::lists=${join(aptRoot, 'lists')}`,
        '-o',
        `Dir::State::status=${join(aptRoot, 'status')}`,
        '-o',
        `Dir::Cache::archives=${join(aptRoot, 'archives')}`,
        '-o',
        `Dir::Etc::sourcelist=${join(aptRoot, 'sources.list')}`,
        '-o',
        'Dir::Etc::sourceparts=-',
        '-o',
        'Acquire::Languages=none',
        // apt only sandboxes downloads when running as root; keep it root then.
        ...(isRoot ? ['-o', 'APT::Sandbox::User=root'] : []),
      ];
      expectOk(await run('apt-get', [...aptOpts, 'update']), 'apt-get update');

      expectOk(
        await run('apt-get', [
          ...aptOpts,
          'install',
          '--download-only',
          '--no-install-recommends',
          '-y',
          'package-test',
        ]),
        'apt-get install --download-only',
      );

      const debPath = join(aptRoot, 'archives', 'package-test_0.12.0-1_amd64.deb');
      expect(existsSync(debPath)).toBe(true);

      const instDir = join(work, 'inst');
      const dpkgDir = join(work, 'dpkg');
      mkdirSync(instDir);
      mkdirSync(dpkgDir);
      expectOk(
        await run('dpkg', [
          `--instdir=${instDir}`,
          `--admindir=${dpkgDir}`,
          '--force-not-root',
          '--install',
          debPath,
        ]),
        'dpkg --install',
      );
      expect(
        readFileSync(join(instDir, 'usr', 'share', 'doc', 'package-test', 'README'), 'utf8'),
      ).toContain('package-test test package');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(
  !full ||
    !commandExists('dnf') ||
    !commandExists('rpm') ||
    !commandExists('rpmbuild') ||
    !commandExists('createrepo_c') ||
    !commandExists('gpg'),
)('rpm client install (e2e)', () => {
  it('dnf verifies the repomd signature and installs the package', async () => {
    const work = mkdtempSync(join(tmpdir(), 'packrat-e2e-rpm-'));
    try {
      await createRepo('e2e-rpm', 'rpm');
      await upload('e2e-rpm', buildRpmPackage());

      const reposDir = join(work, 'repos');
      mkdirSync(reposDir);
      writeFileSync(
        join(reposDir, 'e2e-rpm.repo'),
        [
          '[e2e-rpm]',
          'name=e2e-rpm',
          `baseurl=${baseUrl}/r/e2e-rpm/stable/rpm`,
          'enabled=1',
          'gpgcheck=0',
          'repo_gpgcheck=1',
          `gpgkey=${baseUrl}/r/e2e-rpm/stable/gpg-public-key`,
          '',
        ].join('\n'),
      );

      const rootDir = join(work, 'root');
      expectOk(
        await run('dnf', [
          `--installroot=${rootDir}`,
          '--releasever=/',
          `--setopt=reposdir=${reposDir}`,
          '--disablerepo=*',
          '--enablerepo=e2e-rpm',
          '-y',
          'install',
          'package-test',
        ]),
        'dnf install',
      );

      const query = await run('rpm', ['--root', rootDir, '-q', 'package-test']);
      expectOk(query, 'rpm -q');
      expect(query.stdout).toContain('package-test-0.12.0-1.noarch');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 180_000);
});

describe.skipIf(
  !full || !commandExists('flatpak') || !commandExists('ostree') || !commandExists('gpg'),
)('flatpak client install (e2e)', () => {
  it('flatpak verifies the signed summary and installs the ref', async () => {
    const work = mkdtempSync(join(tmpdir(), 'packrat-e2e-flatpak-'));
    try {
      await createRepo('e2e-flatpak', 'flatpak');
      await upload('e2e-flatpak', buildFlatpakBundle());

      const keyFile = join(work, 'key.asc');
      writeFileSync(keyFile, await fetchKey('e2e-flatpak'));

      // Sandboxed flatpak state: the host's flatpak config is never touched.
      const env: NodeJS.ProcessEnv = {
        FLATPAK_USER_DIR: join(work, 'fp'),
        XDG_CACHE_HOME: join(work, 'cache'),
        XDG_CONFIG_HOME: join(work, 'config'),
        XDG_DATA_HOME: join(work, 'data'),
      };

      expectOk(
        await run(
          'flatpak',
          [
            '--user',
            'remote-add',
            '--if-not-exists',
            '--gpg-import',
            keyFile,
            'e2e',
            `${baseUrl}/r/e2e-flatpak/stable/flatpak/ostree/`,
          ],
          { env },
        ),
        'flatpak remote-add',
      );
      expectOk(
        await run(
          'flatpak',
          ['--user', 'install', '--no-deps', '-y', 'e2e', 'com.test.testpackage'],
          { env },
        ),
        'flatpak install',
      );

      const list = await run('flatpak', ['--user', 'list'], { env });
      expectOk(list, 'flatpak list');
      expect(list.stdout).toContain('com.test.testpackage');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
