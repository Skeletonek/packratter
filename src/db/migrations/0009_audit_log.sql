BEGIN;

-- Actor and subject names are denormalized: entries must stay readable after
-- the user or repo they describe is gone.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_login TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT,
  subject_id TEXT,
  subject_label TEXT,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);

COMMIT;
