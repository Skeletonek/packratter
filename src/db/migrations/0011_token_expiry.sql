BEGIN;

-- Nullable expiry = never expires.
ALTER TABLE tokens ADD COLUMN expires_at INTEGER;
ALTER TABLE tokens ADD COLUMN last_used_at INTEGER;

COMMIT;
