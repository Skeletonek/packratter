import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../config.js';

export function repoEnvDir(repoId: string, envId: string): string {
  return resolve(join(config.DATA_DIR, 'repos', repoId, envId));
}

export function ensureRepoEnvDir(repoId: string, envId: string): string {
  const dir = repoEnvDir(repoId, envId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
