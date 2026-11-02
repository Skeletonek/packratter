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
  const member = memberRole(user, repoId);
  if (member) return member as RepoRole;
  // Repositories marked readable-by-all-users grant viewer access to every
  // signed-in account, grants or not.
  const repo = db.select().from(schema.repos).where(eq(schema.repos.id, repoId)).all()[0];
  return repo?.allUsers ? 'viewer' : null;
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
  const memberIds = db
    .select()
    .from(schema.repoMembers)
    .where(eq(schema.repoMembers.userId, user.id))
    .all()
    .map((row) => row.repoId);
  const openIds = db
    .select({ id: schema.repos.id })
    .from(schema.repos)
    .where(eq(schema.repos.allUsers, true))
    .all()
    .map((row) => row.id);
  return [...new Set([...memberIds, ...openIds])];
}
