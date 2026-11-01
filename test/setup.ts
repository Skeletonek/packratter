import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Full tests drive real package managers (pacman, apt, dnf, flatpak), so they
// must only ever run inside the toolchain container — never on a host.
const inContainer = existsSync('/.dockerenv') || existsSync('/run/.containerenv');
if (process.env.RUN_FULL_TESTS === '1' && !inContainer) {
  throw new Error(
    'RUN_FULL_TESTS drives real package managers and must run in the toolchain container: ' +
      'docker compose -f docker-compose.test.yml run --rm packratter-tests',
  );
}

process.env.NODE_ENV = 'test';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'adminpass';
process.env.BASE_URL = 'http://localhost:5000';

mkdirSync('/tmp/opencode', { recursive: true });
const tmpDir = mkdtempSync(join('/tmp/opencode', 'packrat-test-'));
process.env.DATA_DIR = tmpDir;
process.env.GPG_ROOT = join(tmpDir, 'keys', 'gnupg');
