import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'adminpass';
process.env.BASE_URL = 'http://localhost:5000';

mkdirSync('/tmp/opencode', { recursive: true });
const tmpDir = mkdtempSync(join('/tmp/opencode', 'packrat-test-'));
process.env.DATA_DIR = tmpDir;
process.env.GPG_ROOT = join(tmpDir, 'keys', 'gnupg');
