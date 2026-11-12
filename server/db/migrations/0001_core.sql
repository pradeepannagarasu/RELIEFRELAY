-- Organisations, users and per-organisation counters.
-- Timestamps are ISO-8601 UTC text with milliseconds. Every table is STRICT so column types are enforced.

CREATE TABLE organisations (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  is_synthetic INTEGER NOT NULL CHECK (is_synthetic IN (0, 1)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  organisation_id  TEXT NOT NULL REFERENCES organisations (id),
  display_name     TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  email            TEXT NOT NULL CHECK (length(email) <= 254),
  role             TEXT NOT NULL CHECK (role IN ('admin', 'approver', 'operator', 'viewer')),
  -- Reserved for a future identity provider. Demo authentication does not use it.
  external_auth_id TEXT UNIQUE,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX users_organisation ON users (organisation_id);

CREATE TABLE counters (
  organisation_id TEXT NOT NULL REFERENCES organisations (id),
  name            TEXT NOT NULL,
  value           INTEGER NOT NULL CHECK (value >= 0),
  PRIMARY KEY (organisation_id, name)
) STRICT;

CREATE TRIGGER organisations_no_delete BEFORE DELETE ON organisations
BEGIN
  SELECT RAISE(ABORT, 'organisations cannot be deleted');
END;

CREATE TRIGGER users_no_delete BEFORE DELETE ON users
BEGIN
  SELECT RAISE(ABORT, 'users cannot be deleted');
END;

CREATE TRIGGER counters_only_increase BEFORE UPDATE ON counters
WHEN NEW.value < OLD.value OR NEW.organisation_id IS NOT OLD.organisation_id OR NEW.name IS NOT OLD.name
BEGIN
  SELECT RAISE(ABORT, 'counters can only increase');
END;

CREATE TRIGGER counters_no_delete BEFORE DELETE ON counters
BEGIN
  SELECT RAISE(ABORT, 'counters cannot be deleted');
END;
