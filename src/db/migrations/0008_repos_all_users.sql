BEGIN;

-- When set, every signed-in user gets viewer access without a grant.
ALTER TABLE repos ADD COLUMN all_users INTEGER NOT NULL DEFAULT 0;

COMMIT;
