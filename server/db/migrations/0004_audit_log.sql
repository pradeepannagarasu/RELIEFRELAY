-- Tamper-evident audit log.
--
-- audit_events is append-only. The database assigns the sequence number and the timestamp, and an insert
-- trigger extends a SHA-256 hash chain in audit_chain: each hash covers the previous hash and the event's
-- content. rr_sha256() is registered by the ReliefRelay server on every connection, so tools that have not
-- registered it cannot write audit events at all.
--
-- This makes tampering evident, not impossible. Anyone with write access to the database file can drop
-- these triggers, rewrite rows and recompute the whole chain. Deleting the newest events is only
-- detectable against a chain head recorded outside the database (npm run db:verify-audit prints it).

CREATE TABLE audit_events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  organisation_id TEXT NOT NULL REFERENCES organisations (id),
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_user_id   TEXT REFERENCES users (id),
  actor_role      TEXT CHECK (actor_role IN ('admin', 'approver', 'operator', 'viewer')),
  action          TEXT NOT NULL CHECK (action GLOB '[a-z]*.[a-z]*' AND length(action) <= 64),
  entity_type     TEXT NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 40),
  entity_id       TEXT,
  outcome         TEXT NOT NULL CHECK (outcome IN ('succeeded', 'rejected')),
  request_id      TEXT,
  previous_state  TEXT CHECK (previous_state IS NULL OR json_valid(previous_state)),
  new_state       TEXT CHECK (new_state IS NULL OR json_valid(new_state)),
  reason          TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  CHECK ((actor_type = 'user') = (actor_user_id IS NOT NULL AND actor_role IS NOT NULL))
) STRICT;

CREATE INDEX audit_events_entity ON audit_events (entity_type, entity_id);
CREATE INDEX audit_events_organisation ON audit_events (organisation_id, seq);

CREATE TABLE audit_chain (
  seq       INTEGER PRIMARY KEY REFERENCES audit_events (seq),
  prev_hash TEXT CHECK (prev_hash IS NULL OR length(prev_hash) = 64),
  hash      TEXT NOT NULL CHECK (length(hash) = 64),
  CHECK ((seq = 1) = (prev_hash IS NULL))
) STRICT;

CREATE TRIGGER audit_events_database_clock BEFORE INSERT ON audit_events
WHEN NEW.recorded_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
BEGIN
  SELECT RAISE(ABORT, 'audit_events.recorded_at is assigned by the database clock');
END;

CREATE TRIGGER audit_events_extend_chain AFTER INSERT ON audit_events
BEGIN
  INSERT INTO audit_chain (seq, prev_hash, hash)
  SELECT NEW.seq,
         head.hash,
         rr_sha256(coalesce(head.hash, 'GENESIS') || char(10) || json_array(
           NEW.seq, NEW.recorded_at, NEW.organisation_id, NEW.actor_type, NEW.actor_user_id, NEW.actor_role,
           NEW.action, NEW.entity_type, NEW.entity_id, NEW.outcome, NEW.request_id,
           NEW.previous_state, NEW.new_state, NEW.reason))
  FROM (SELECT max(seq) AS seq FROM audit_chain) AS last
  LEFT JOIN audit_chain AS head ON head.seq = last.seq;
END;

-- Rejects chain rows that do not extend the chain correctly, including rows inserted directly.
CREATE TRIGGER audit_chain_verify_insert BEFORE INSERT ON audit_chain
BEGIN
  SELECT RAISE(ABORT, 'audit chain must be extended by exactly one consecutive event')
  WHERE NEW.seq IS NOT (SELECT coalesce(max(seq), 0) + 1 FROM audit_chain);
  SELECT RAISE(ABORT, 'audit chain previous hash does not match the chain head')
  WHERE NEW.prev_hash IS NOT (SELECT hash FROM audit_chain WHERE seq = NEW.seq - 1);
  SELECT RAISE(ABORT, 'audit chain hash does not match the event content')
  WHERE NEW.hash IS NOT (
    SELECT rr_sha256(coalesce(NEW.prev_hash, 'GENESIS') || char(10) || json_array(
      e.seq, e.recorded_at, e.organisation_id, e.actor_type, e.actor_user_id, e.actor_role,
      e.action, e.entity_type, e.entity_id, e.outcome, e.request_id,
      e.previous_state, e.new_state, e.reason))
    FROM audit_events AS e WHERE e.seq = NEW.seq);
END;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_chain_no_update BEFORE UPDATE ON audit_chain
BEGIN
  SELECT RAISE(ABORT, 'audit_chain is append-only');
END;

CREATE TRIGGER audit_chain_no_delete BEFORE DELETE ON audit_chain
BEGIN
  SELECT RAISE(ABORT, 'audit_chain is append-only');
END;
