import type { RepoType } from '../formats/index.js';

interface SortablePackage {
  filename: string;
  version: string | null;
  arch: string | null;
  ref?: string | null;
}

export function compareVersion(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;

  const as = a.split(/[._+-]/).filter(Boolean);
  const bs = b.split(/[._+-]/).filter(Boolean);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) {
      const n = Number(x) - Number(y);
      if (n !== 0) return n;
    } else if (numericX !== numericY) {
      // Numeric segments outrank textual ones, like rpm's version ordering.
      return numericX ? 1 : -1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// The packages table has no name column, so it is recovered from the
// filename grammar the ingest step produced.
function baseName(pkg: SortablePackage, type: RepoType): string {
  if (type === 'flatpak') {
    const parts = pkg.ref?.split('/');
    if (parts?.length === 4) return parts[1];
    return pkg.filename;
  }
  if (type === 'deb') {
    return pkg.filename.split('_')[0];
  }

  const stem = pkg.filename.replace(/\.rpm$/, '').replace(/\.pkg\.tar\.zst$|\.pkg\.tar\.xz$/, '');
  if (type === 'rpm' && pkg.version != null && pkg.arch != null) {
    const suffix = `-${pkg.version}.${pkg.arch}`;
    if (stem.endsWith(suffix)) return stem.slice(0, -suffix.length);
    return stem;
  }
  if (type === 'pacman' && pkg.version != null && pkg.arch != null) {
    const suffix = `-${pkg.version}-${pkg.arch}`;
    if (stem.endsWith(suffix)) return stem.slice(0, -suffix.length);
    return stem;
  }
  return stem;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortPackages<T extends SortablePackage>(rows: T[], type: RepoType): T[] {
  return [...rows].sort(
    (a, b) =>
      compareText(baseName(a, type), baseName(b, type)) ||
      -compareVersion(a.version, b.version) ||
      compareText(a.arch ?? '', b.arch ?? ''),
  );
}
