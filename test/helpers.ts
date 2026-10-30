import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

export function commandExists(cmd: string): boolean {
  return !spawnSync(cmd, ['--version'], { encoding: 'utf8' }).error;
}

export function pacmanFilename(pkgname: string, pkgver = '1.0.0', arch = 'x86_64'): string {
  return `${pkgname}-${pkgver}-1-${arch}.pkg.tar.zst`;
}

export function buildPacmanPackage(pkgname: string, pkgver = '1.0.0', arch = 'x86_64'): Buffer {
  const base = mkdtempSync(join(tmpdir(), 'packrat-pkg-'));
  const cwd = join(base, 'root');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(cwd, '.PKGINFO'),
    `pkgname = ${pkgname}\npkgver = ${pkgver}\npkgrel = 1\narch = ${arch}\n`,
  );
  const pkgPath = join(base, pacmanFilename(pkgname, pkgver, arch));
  const result = spawnSync('bsdtar', ['-c', '--zstd', '-f', pkgPath, '.PKGINFO'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`bsdtar failed: ${result.error?.message ?? result.stderr}`);
  }
  const bytes = readFileSync(pkgPath);
  rmSync(base, { recursive: true, force: true });
  return bytes;
}

export async function waitForJob(
  server: FastifyInstance,
  headers: Record<string, string>,
  jobId: string,
): Promise<{ status: string; log: string }> {
  let job: { status: string; log: string } | null = null;
  for (let i = 0; i < 60; i++) {
    const res = await server.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers });
    job = res.json().data;
    if (job?.status === 'done' || job?.status === 'error') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!job) throw new Error(`job ${jobId} not found`);
  return job;
}
