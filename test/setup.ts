import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'adminpass';

mkdirSync('/tmp/opencode', { recursive: true });
process.env.DATA_DIR = mkdtempSync(join('/tmp/opencode', 'packrat-test-'));
