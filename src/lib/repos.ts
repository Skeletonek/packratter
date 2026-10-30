import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { AppError } from '../errors.js';

// Repos and envs are addressed by name in URLs (both names are UNIQUE per parent).
export function resolveRepo(repoParam: string) {
  const row = db.select().from(schema.repos).where(eq(schema.repos.name, repoParam)).all()[0];
  if (!row) throw new AppError('NOT_FOUND', 'repo not found', 404);
  return row;
}

export function resolveEnv(repoId: string, envName: string) {
  const row = db
    .select()
    .from(schema.envs)
    .where(and(eq(schema.envs.repoId, repoId), eq(schema.envs.name, envName)))
    .all()[0];
  if (!row) throw new AppError('NOT_FOUND', 'env not found', 404);
  return row;
}
