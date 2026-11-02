BEGIN;

-- Runtime-editable OIDC configuration (single row). On first boot the SSO_*
-- environment variables seed this table when it is empty; afterwards the row
-- is authoritative and later .env changes have no effect.
CREATE TABLE IF NOT EXISTS sso_config (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT,
  scopes TEXT NOT NULL DEFAULT 'openid profile email',
  admin_claim TEXT,
  admin_value TEXT,
  auto_create INTEGER NOT NULL DEFAULT 1,
  seeded_from_env INTEGER NOT NULL DEFAULT 0
);

COMMIT;
