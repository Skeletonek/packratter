import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

export const repos = sqliteTable('repos', {
  id: text().primaryKey(),
  name: text().notNull().unique(),
  type: text().notNull(),
  // flatpak only: where bundle refs come from — 'env' names the branch after
  // the environment, 'bundle' keeps whatever branch the bundle was built with.
  branchMode: text('branch_mode').notNull().default('env'),
  createdAt: integer('created_at').notNull(),
});

export const envs = sqliteTable('envs', {
  id: text().primaryKey(),
  repoId: text('repo_id')
    .notNull()
    .references(() => repos.id, { onDelete: 'cascade' }),
  name: text().notNull(),
});

export const packages = sqliteTable('packages', {
  id: text().primaryKey(),
  envId: text('env_id')
    .notNull()
    .references(() => envs.id, { onDelete: 'cascade' }),
  filename: text().notNull(),
  version: text(),
  arch: text(),
  size: integer(),
  sha256: text(),
  ref: text(),
  status: text().notNull(),
  createdAt: integer('created_at').notNull(),
});

export const gpgKeys = sqliteTable('gpg_keys', {
  id: text().primaryKey(),
  fingerprint: text().notNull().unique(),
  publicArmored: text('public_armored').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const repoKeys = sqliteTable(
  'repo_keys',
  {
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    keyId: text('key_id')
      .notNull()
      .references(() => gpgKeys.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.keyId] })],
);

export const users = sqliteTable('users', {
  id: text().primaryKey(),
  login: text().notNull().unique(),
  email: text(),
  displayName: text('display_name'),
  passHash: text('pass_hash').notNull(),
  role: text().notNull(),
  createdAt: integer('created_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  // sha256 of the cookie value, never the value itself
  id: text().primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at').notNull(),
});

export const tokens = sqliteTable('tokens', {
  id: text().primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  prefix: text().notNull(),
  hash: text().notNull(),
  scopes: text().notNull(),
  createdAt: integer('created_at').notNull(),
});

export const jobs = sqliteTable('jobs', {
  id: text().primaryKey(),
  repoId: text('repo_id').references(() => repos.id, { onDelete: 'set null' }),
  envId: text('env_id').references(() => envs.id, { onDelete: 'set null' }),
  kind: text().notNull(),
  status: text().notNull(),
  log: text().notNull().default(''),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: integer('created_at').notNull(),
});
