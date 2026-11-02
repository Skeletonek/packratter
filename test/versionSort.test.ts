import { describe, expect, it } from 'vitest';

import { compareVersion, sortPackages } from '../src/lib/packageSort.js';
import type { RepoType } from '../src/formats/index.js';

function row(
  filename: string,
  version: string | null,
  arch: string | null = 'x86_64',
  ref: string | null = null,
) {
  return { filename, version, arch, ref };
}

describe('compareVersion', () => {
  it('orders numeric segments numerically', () => {
    expect(compareVersion('1.9', '1.10')).toBeLessThan(0);
    expect(compareVersion('2.0', '10.0')).toBeLessThan(0);
    expect(compareVersion('1.0-1', '1.0-2')).toBeLessThan(0);
    expect(compareVersion('1.0.0', '1.0')).toBeGreaterThan(0);
    expect(compareVersion('1.0-rc1', '1.0')).toBeGreaterThan(0);
  });

  it('treats null as the lowest version', () => {
    expect(compareVersion(null, '0')).toBeLessThan(0);
    expect(compareVersion('0', null)).toBeGreaterThan(0);
    expect(compareVersion(null, null)).toBe(0);
  });

  it('counts identical versions as equal', () => {
    expect(compareVersion('1.0.0-1', '1.0.0-1')).toBe(0);
    expect(compareVersion('10', '010')).toBe(0);
  });
});

describe('sortPackages', () => {
  it('sorts pacman by name, version descending, then arch', () => {
    const rows = [
      row('pkg-b-1.0-1-x86_64.pkg.tar.zst', '1.0-1'),
      row('pkg-a-1.9-1-x86_64.pkg.tar.zst', '1.9-1'),
      row('pkg-a-1.10-2-x86_64.pkg.tar.zst', '1.10-2'),
      row('pkg-a-1.10-1-any.pkg.tar.zst', '1.10-1', 'any'),
      row('pkg-a-1.10-1-x86_64.pkg.tar.zst', '1.10-1'),
      row('pkg-a-1.0-1-i686.pkg.tar.zst', '1.0-1', 'i686'),
    ];

    expect(sortPackages(rows, 'pacman').map((r) => r.filename)).toEqual([
      'pkg-a-1.10-2-x86_64.pkg.tar.zst',
      'pkg-a-1.10-1-any.pkg.tar.zst',
      'pkg-a-1.10-1-x86_64.pkg.tar.zst',
      'pkg-a-1.9-1-x86_64.pkg.tar.zst',
      'pkg-a-1.0-1-i686.pkg.tar.zst',
      'pkg-b-1.0-1-x86_64.pkg.tar.zst',
    ]);
  });

  it('sorts deb by package name before all versions', () => {
    const rows = [
      row('basepkg_2.0-1_all.deb', '2.0-1', 'all'),
      row('app_1.0.0-1_amd64.deb', '1.0.0-1', 'amd64'),
      row('app_1.2.0-1_arm64.deb', '1.2.0-1', 'arm64'),
      row('app_1.2.0-1_amd64.deb', '1.2.0-1', 'amd64'),
    ];

    expect(sortPackages(rows, 'deb').map((r) => r.filename)).toEqual([
      'app_1.2.0-1_amd64.deb',
      'app_1.2.0-1_arm64.deb',
      'app_1.0.0-1_amd64.deb',
      'basepkg_2.0-1_all.deb',
    ]);
  });

  it('sorts rpm by the name before the version suffix', () => {
    const rows = [
      row('pkg-tool-1.5-1.noarch.rpm', '1.5-1', 'noarch'),
      row('other-0.1-1.x86_64.rpm', '0.1-1', 'x86_64'),
      row('pkg-tool-1.5-2.noarch.rpm', '1.5-2', 'noarch'),
    ];

    expect(sortPackages(rows, 'rpm').map((r) => r.filename)).toEqual([
      'other-0.1-1.x86_64.rpm',
      'pkg-tool-1.5-2.noarch.rpm',
      'pkg-tool-1.5-1.noarch.rpm',
    ]);
  });

  it('groups flatpak by app id from the ref and keeps versionless rows last', () => {
    const rows = [
      row(
        'app_com.test.X_x86_64_stable.flatpak',
        '1.1.0',
        'x86_64',
        'app/com.test.X/x86_64/stable',
      ),
      row('app_com.a.bit_x86_64_master.flatpak', null, 'x86_64', 'app/com.a.bit/x86_64/master'),
      row(
        'app_com.test.X_x86_64_testing.flatpak',
        '1.0.9',
        'x86_64',
        'app/com.test.X/x86_64/testing',
      ),
    ];

    expect(sortPackages(rows, 'flatpak').map((r) => r.filename)).toEqual([
      'app_com.a.bit_x86_64_master.flatpak',
      'app_com.test.X_x86_64_stable.flatpak',
      'app_com.test.X_x86_64_testing.flatpak',
    ]);
  });
});
