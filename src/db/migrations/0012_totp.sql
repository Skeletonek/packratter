BEGIN;

ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
-- JSON array of sha256 hashes of one-time recovery codes.
ALTER TABLE users ADD COLUMN totp_recovery_codes TEXT;

COMMIT;
