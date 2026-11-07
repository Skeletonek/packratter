BEGIN;

-- Link SSO identities to existing accounts by email only when the IdP asserts
-- email_verified. Off by default (Authentik et al. leave the claim unset).
ALTER TABLE sso_config ADD COLUMN require_verified_email INTEGER NOT NULL DEFAULT 0;

COMMIT;
