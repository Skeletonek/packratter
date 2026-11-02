import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const uiSrc = fileURLToPath(new URL('../ui/src', import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
    } else {
      out.push(path);
    }
  }
  return out;
}

describe('UI contracts', () => {
  const files = walk(uiSrc).filter((f) => /\.(svelte|ts|js)$/.test(f));

  it('never uses the $page store accessor', () => {
    const offenders = files.filter((f) => /\$page\b/.test(readFileSync(f, 'utf8')));
    const detail = offenders.map((f) => f.replace(uiSrc, 'ui/src')).join(', ');
    expect(
      offenders,
      `${detail} use '$page'. page from '$app/state' is a reactive object, not a store — ` +
        "'$page' compiles to .subscribe() and crashes at runtime. Use page.params directly.",
    ).toEqual([]);
  });

  it("doesn't import from $app/stores (legacy store path)", () => {
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('$app/stores'));
    expect(offenders, offenders.map((f) => f.replace(uiSrc, 'ui/src')).join(', ')).toEqual([]);
  });

  it('offers SSO sign-in on the login page when configured', () => {
    const loginPage = readFileSync(join(uiSrc, 'routes/login/+page.svelte'), 'utf8');
    expect(loginPage).toContain('/api/v1/auth/sso/status');
    expect(loginPage).toContain('/api/v1/auth/sso/start');
  });
});
