import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // Real makepkg writes the combined pkgver-pkgrel into .PKGINFO and no pkgrel.
  writeFileSync(
    join(cwd, '.PKGINFO'),
    `pkgname = ${pkgname}\npkgver = ${pkgver}-1\narch = ${arch}\n`,
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

export function buildDebPackage(pkgname = 'package-test', version = '0.12.0-1'): Buffer {
  const base = mkdtempSync(join(tmpdir(), 'packrat-deb-'));
  const pkgDir = join(base, 'pkg');
  mkdirSync(join(pkgDir, 'DEBIAN'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'DEBIAN', 'control'),
    `Package: ${pkgname}\nVersion: ${version}\nArchitecture: amd64\nMaintainer: Test <test@example.com>\nDescription: Tiny test package\n`,
  );
  const docDir = join(pkgDir, 'usr', 'share', 'doc', pkgname);
  mkdirSync(docDir, { recursive: true });
  writeFileSync(join(docDir, 'README'), `${pkgname} test package\n`);
  const debPath = join(base, `${pkgname}_${version}_amd64.deb`);
  const result = spawnSync('dpkg-deb', ['--build', pkgDir, debPath], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`dpkg-deb --build failed: ${result.error?.message ?? result.stderr}`);
  }
  const bytes = readFileSync(debPath);
  rmSync(base, { recursive: true, force: true });
  return bytes;
}

export function buildRpmPackage(pkgname = 'package-test', version = '0.12.0'): Buffer {
  const base = mkdtempSync(join(tmpdir(), 'packrat-rpm-'));
  for (const dir of ['BUILD', 'BUILDROOT', 'RPMS', 'SOURCES', 'SPECS', 'SRPMS']) {
    mkdirSync(join(base, dir));
  }
  const specPath = join(base, 'SPECS', `${pkgname}.spec`);
  writeFileSync(
    specPath,
    `Name:           ${pkgname}
Version:        ${version}
Release:        1
Summary:        Tiny test package
License:        MIT
BuildArch:      noarch

%description
Tiny test package used by packratter tests.

%install
mkdir -p %{buildroot}/usr/share/doc/${pkgname}
echo "${pkgname} test package" > %{buildroot}/usr/share/doc/${pkgname}/README

%files
/usr/share/doc/${pkgname}/README
`,
  );
  const result = spawnSync('rpmbuild', ['-bb', '--define', `_topdir ${base}`, specPath], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`rpmbuild failed: ${result.error?.message ?? result.stderr}`);
  }
  const rpmPath = join(base, 'RPMS', 'noarch', `${pkgname}-${version}-1.noarch.rpm`);
  const bytes = readFileSync(rpmPath);
  rmSync(base, { recursive: true, force: true });
  return bytes;
}

export function buildFlatpakBundle(
  appId = 'com.test.testpackage',
  branch = 'master',
  version = '2.7.3',
): Buffer {
  const base = mkdtempSync(join(tmpdir(), 'packrat-flatpak-'));
  const buildDir = join(base, 'build');
  const repoDir = join(base, 'repo');
  mkdirSync(join(buildDir, 'files', 'bin'), { recursive: true });
  writeFileSync(
    join(buildDir, 'metadata'),
    `[Application]\nname=${appId}\nruntime=org.test.Platform/x86_64/master\nsdk=org.test.Sdk/x86_64/master\ncommand=${appId}\n`,
  );
  const metainfoDir = join(buildDir, 'files', 'share', 'metainfo');
  mkdirSync(metainfoDir, { recursive: true });
  writeFileSync(
    join(metainfoDir, `${appId}.metainfo.xml`),
    `<?xml version="1.0" encoding="UTF-8"?>
<component type="application">
  <id>${appId}</id>
  <name>${appId}</name>
  <summary>Test app used by packratter tests.</summary>
  <releases>
    <release version="${version}" date="2026-11-01"/>
  </releases>
</component>
`,
  );
  writeFileSync(join(buildDir, 'files', 'bin', appId), '#!/bin/sh\necho hi\n');
  chmodSync(join(buildDir, 'files', 'bin', appId), 0o755);

  // A stub app suffices: packratter only imports and serves bundles, so the
  // contents are irrelevant and no SDK/runtime has to be installed.
  const steps: [string, string[]][] = [
    ['flatpak', ['build-finish', buildDir]],
    ['flatpak', ['build-export', repoDir, buildDir, branch]],
    ['flatpak', ['build-bundle', repoDir, join(base, 'bundle.flatpak'), appId, branch]],
  ];
  for (const [cmd, args] of steps) {
    const result = spawnSync(cmd, args, {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    if (result.status !== 0 || result.error) {
      throw new Error(`${cmd} failed: ${result.error?.message ?? result.stderr}`);
    }
  }
  const bytes = readFileSync(join(base, 'bundle.flatpak'));
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
