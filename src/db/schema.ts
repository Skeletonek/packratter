import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

export const repos = sqliteTable('repos', {
  id: text().primaryKey(),
  name: text().notNull().unique(),
  type: text().notNull(),
  // flatpak only: where bundle refs come from — 'env' names the branch after
  // the environment, 'bundle' keeps whatever branch the bundle was built with.
  branchMode: text('branch_mode').notNull().default('env'),
  // every signed-in user gets viewer access without an explicit grant
  allUsers: integer('all_users', { mode: 'boolean' }).notNull().default(false),
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
    /** Exactly one active key per repo signs; replaced keys stay public-downloadable. */
    active: integer({ mode: 'boolean' }).notNull().default(true),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.keyId] })],
);

export const users = sqliteTable('users', {
  id: text().primaryKey(),
  login: text().notNull().unique(),
  email: text(),
  displayName: text('display_name'),
  /** Null for SSO-only accounts: they have no local password. */
  passHash: text('pass_hash'),
  role: text().notNull(),
  /** OIDC subject of the linked identity; unique when present. */
  ssoSub: text('sso_sub'),
  /** Set once an admin hand-edits the role; the SSO claim stops managing it. */
  roleManaged: integer('role_managed', { mode: 'boolean' }).notNull().default(false),
  /** Base32 TOTP secret; present from enrollment, enabled flag decides use. */
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
  /** JSON array of sha256 hashes of one-time recovery codes. */
  totpRecoveryCodes: text('totp_recovery_codes'),
  /** Highest TOTP time-step already accepted; blocks code replay. */
  totpLastUsedStep: integer('totp_last_used_step').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const repoMembers = sqliteTable(
  'repo_members',
  {
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'maintainer' | 'viewer' */
    role: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.userId] })],
);

export const ssoConfig = sqliteTable('sso_config', {
  /** Single row, id 'default'. */
  id: text().primaryKey(),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  issuer: text().notNull(),
  clientId: text('client_id').notNull(),
  /** Null for public OIDC clients (PKCE only). Never served to the UI. */
  clientSecret: text('client_secret'),
  scopes: text().notNull(),
  adminClaim: text('admin_claim'),
  adminValue: text('admin_value'),
  autoCreate: integer('auto_create', { mode: 'boolean' }).notNull().default(true),
  /** Link by email only when the IdP asserts email_verified. */
  requireVerifiedEmail: integer('require_verified_email', { mode: 'boolean' })
    .notNull()
    .default(false),
  seededFromEnv: integer('seeded_from_env', { mode: 'boolean' }).notNull().default(false),
});

export const sessions = sqliteTable('sessions', {
  // sha256 of the cookie value, never the value itself
  id: text().primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull().default(0),
  userAgent: text('user_agent'),
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
  /** Null = never expires. */
  expiresAt: integer('expires_at'),
  lastUsedAt: integer('last_used_at'),
});

export const auditLog = sqliteTable('audit_log', {
  id: text().primaryKey(),
  at: integer().notNull(),
  actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
  // Denormalized so entries stay readable after the actor or subject is gone.
  actorLogin: text('actor_login').notNull(),
  action: text().notNull(),
  subjectType: text('subject_type'),
  subjectId: text('subject_id'),
  subjectLabel: text('subject_label'),
  details: text(),
});

export const webauthnCredentials = sqliteTable('webauthn_credentials', {
  id: text().primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  publicKey: text('public_key').notNull(),
  counter: integer().notNull().default(0),
  transports: text(),
  label: text(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
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
