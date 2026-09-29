ALTER TABLE users
  ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0
  CHECK (must_change_password IN (0, 1));

CREATE TABLE auth_attempts (
  email_hash TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  window_started_at TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL
);

CREATE INDEX auth_attempts_last_attempt_idx ON auth_attempts(last_attempt_at);

UPDATE setup_state SET schema_version = 2 WHERE id = 1;
