PRAGMA journal_mode = WAL;

BEGIN;

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS envs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE(repo_id, name)
);

CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  env_id TEXT NOT NULL REFERENCES envs(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  version TEXT,
  arch TEXT,
  size INTEGER,
  sha256 TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_envs_repo ON envs(repo_id);
CREATE INDEX IF NOT EXISTS idx_packages_env_filename ON packages(env_id, filename);

CREATE TABLE IF NOT EXISTS gpg_keys (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  public_armored TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS repo_keys (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL REFERENCES gpg_keys(id) ON DELETE CASCADE,
  PRIMARY KEY (repo_id, key_id)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  repo_id TEXT REFERENCES repos(id) ON DELETE SET NULL,
  env_id TEXT REFERENCES envs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  log TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);

COMMIT;
