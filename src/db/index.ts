import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

const dbPath = `${config.DATA_DIR}/db.sqlite`;
mkdirSync(config.DATA_DIR, { recursive: true });

export const sqlite = new DatabaseSync(dbPath);

sqlite.exec('PRAGMA journal_mode = WAL;');
sqlite.exec('PRAGMA foreign_keys = ON;');

export const db = drizzle({ client: sqlite });

export function applyMigrations(): void {
  const migrationsDir = join(import.meta.dirname, 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    sqlite.exec(sql);
  }
}
