import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { AppError } from '../errors.js';

export type RepoRole = 'admin' | 'maintainer' | 'viewer';

const RANK: Record<RepoRole, number> = { admin: 3, maintainer: 2, viewer: 1 };

interface AccessUser {
  id: string;
  role: string;
}

function memberRole(user: AccessUser, repoId: string): string | null {
  const row = db
    .select()
    .from(schema.repoMembers)
    .where(and(eq(schema.repoMembers.repoId, repoId), eq(schema.repoMembers.userId, user.id)))
    .all()[0];
  return row?.role ?? null;
}

/** Effective role for one repo; global admins are admins everywhere. */
export function repoRole(user: AccessUser, repoId: string): RepoRole | null {
  if (user.role === 'admin') return 'admin';
  return memberRole(user, repoId) as RepoRole | null;
}

// No grant at all is 404, not 403: a repo the user cannot access must be
// indistinguishable from one that does not exist.
export function requireRepoRole(user: AccessUser, repoId: string, min: RepoRole): void {
  const role = repoRole(user, repoId);
  if (role === null) throw new AppError('NOT_FOUND', 'repo not found', 404);
  if (RANK[role] < RANK[min]) {
    throw new AppError('FORBIDDEN', `${min} access required for this repository`, 403);
  }
}

/** null = unrestricted (admin); otherwise the granted repo ids (possibly empty). */
export function visibleRepoIds(user: AccessUser): string[] | null {
  if (user.role === 'admin') return null;
  return db
    .select()
    .from(schema.repoMembers)
    .where(eq(schema.repoMembers.userId, user.id))
    .all()
    .map((row) => row.repoId);
}
