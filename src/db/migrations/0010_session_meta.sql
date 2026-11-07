BEGIN;

-- Enough context for the Account page to tell devices apart.
ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;

COMMIT;
