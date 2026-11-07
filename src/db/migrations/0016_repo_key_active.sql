BEGIN;

-- One signing key per repo is active at a time; replaced keys stay linked
-- (public-only) so clients can download them during a transition.
ALTER TABLE repo_keys ADD COLUMN active INTEGER NOT NULL DEFAULT 1;

COMMIT;
