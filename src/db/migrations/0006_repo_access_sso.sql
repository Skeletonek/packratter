BEGIN;

-- SSO-only accounts have no local password.
ALTER TABLE users ALTER COLUMN pass_hash DROP NOT NULL;

-- OIDC subject of the linked identity.
ALTER TABLE users ADD COLUMN sso_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso_sub ON users(sso_sub) WHERE sso_sub IS NOT NULL;

-- Set once an admin hand-edits the role: the SSO claim stops managing it.
ALTER TABLE users ADD COLUMN role_managed INTEGER NOT NULL DEFAULT 0;

-- Per-repo grants: 'maintainer' or 'viewer'. Global admins need no row.
CREATE TABLE IF NOT EXISTS repo_members (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (repo_id, user_id)
);

COMMIT;
