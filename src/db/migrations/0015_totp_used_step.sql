BEGIN;

-- Highest TOTP time-step already accepted; blocks replay of a captured code.
ALTER TABLE users ADD COLUMN totp_last_used_step INTEGER NOT NULL DEFAULT 0;

COMMIT;
