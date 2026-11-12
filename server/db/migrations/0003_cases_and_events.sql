-- Payment cases, reconciliation findings, notes and the payment event timeline.

CREATE TABLE payment_cases (
  id                  TEXT PRIMARY KEY,
  organisation_id     TEXT NOT NULL REFERENCES organisations (id),
  reference           TEXT NOT NULL,
  payment_item_id     TEXT NOT NULL REFERENCES payment_items (id),
  state               TEXT NOT NULL CHECK (state IN ('open', 'investigating', 'awaiting_approval', 'recovery_submitted', 'resolved', 'closed')),
  basis               TEXT NOT NULL CHECK (basis IN ('provider_confirmed', 'imported_record', 'reconciliation_conflict')),
  opening_reason      TEXT NOT NULL,
  assignee_user_id    TEXT REFERENCES users (id),
  opened_at           TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  resolution_kind     TEXT CHECK (resolution_kind IN ('recovered', 'closed_no_action')),
  resolution_summary  TEXT,
  resolved_at         TEXT,
  resolved_by_user_id TEXT REFERENCES users (id),
  recovery_item_id    TEXT REFERENCES payment_items (id),
  UNIQUE (organisation_id, reference),
  CHECK ((state IN ('resolved', 'closed')) = (resolution_kind IS NOT NULL)),
  CHECK (resolution_kind IS NULL OR (resolution_summary IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL)),
  CHECK (resolution_kind IS NOT 'recovered' OR recovery_item_id IS NOT NULL)
) STRICT;

-- At most one active case per payment.
CREATE UNIQUE INDEX payment_cases_one_active ON payment_cases (payment_item_id) WHERE state NOT IN ('resolved', 'closed');
CREATE INDEX payment_cases_organisation_state ON payment_cases (organisation_id, state);

CREATE TRIGGER payment_cases_versioned BEFORE UPDATE ON payment_cases
WHEN NEW.version IS NOT OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'payment case updates must increment version by exactly 1');
END;

CREATE TRIGGER payment_cases_immutable_identity BEFORE UPDATE ON payment_cases
WHEN NEW.id IS NOT OLD.id
  OR NEW.organisation_id IS NOT OLD.organisation_id
  OR NEW.reference IS NOT OLD.reference
  OR NEW.payment_item_id IS NOT OLD.payment_item_id
  OR NEW.basis IS NOT OLD.basis
  OR NEW.opening_reason IS NOT OLD.opening_reason
  OR NEW.opened_at IS NOT OLD.opened_at
BEGIN
  SELECT RAISE(ABORT, 'case identity and opening basis cannot be changed');
END;

CREATE TRIGGER payment_cases_no_delete BEFORE DELETE ON payment_cases
BEGIN
  SELECT RAISE(ABORT, 'payment cases cannot be deleted');
END;

-- Output of the deterministic reconciliation rules. Append-only.
CREATE TABLE reconciliation_findings (
  id               TEXT PRIMARY KEY,
  organisation_id  TEXT NOT NULL REFERENCES organisations (id),
  payment_item_id  TEXT NOT NULL REFERENCES payment_items (id),
  import_id        TEXT REFERENCES imports (id),
  row_number       INTEGER,
  code             TEXT NOT NULL CHECK (code IN (
                     'exception_status_recorded', 'stale_unclaimed', 'stale_pending', 'error_code_on_success',
                     'possible_duplicate_payment', 'reference_conflict', 'provider_status_conflict',
                     'provider_reference_mismatch', 'imported_status_changed')),
  severity         TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  expected         TEXT CHECK (expected IS NULL OR json_valid(expected)),
  actual           TEXT CHECK (actual IS NULL OR json_valid(actual)),
  related_item_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(related_item_ids) AND json_type(related_item_ids) = 'array'),
  detail           TEXT NOT NULL,
  rule_version     INTEGER NOT NULL CHECK (rule_version >= 1),
  recorded_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((import_id IS NULL) = (row_number IS NULL))
) STRICT;

CREATE INDEX reconciliation_findings_item ON reconciliation_findings (payment_item_id);

CREATE TRIGGER reconciliation_findings_no_update BEFORE UPDATE ON reconciliation_findings
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_findings is append-only');
END;

CREATE TRIGGER reconciliation_findings_no_delete BEFORE DELETE ON reconciliation_findings
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_findings is append-only');
END;

CREATE TABLE case_findings (
  case_id    TEXT NOT NULL REFERENCES payment_cases (id),
  finding_id TEXT NOT NULL REFERENCES reconciliation_findings (id),
  linked_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (case_id, finding_id)
) STRICT;

CREATE TRIGGER case_findings_no_update BEFORE UPDATE ON case_findings
BEGIN
  SELECT RAISE(ABORT, 'case_findings is append-only');
END;

CREATE TRIGGER case_findings_no_delete BEFORE DELETE ON case_findings
BEGIN
  SELECT RAISE(ABORT, 'case_findings is append-only');
END;

-- Operator notes. A correction is a new note; notes are never edited or removed.
CREATE TABLE case_notes (
  id             TEXT PRIMARY KEY,
  case_id        TEXT NOT NULL REFERENCES payment_cases (id),
  author_user_id TEXT NOT NULL REFERENCES users (id),
  body           TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX case_notes_case ON case_notes (case_id, created_at);

CREATE TRIGGER case_notes_no_update BEFORE UPDATE ON case_notes
BEGIN
  SELECT RAISE(ABORT, 'case_notes is append-only');
END;

CREATE TRIGGER case_notes_no_delete BEFORE DELETE ON case_notes
BEGIN
  SELECT RAISE(ABORT, 'case_notes is append-only');
END;

-- Timeline of provider, import, system and operator events for each payment. Append-only.
CREATE TABLE payment_events (
  id                  TEXT PRIMARY KEY,
  organisation_id     TEXT NOT NULL REFERENCES organisations (id),
  batch_id            TEXT NOT NULL REFERENCES payment_batches (id),
  payment_item_id     TEXT REFERENCES payment_items (id),
  case_id             TEXT REFERENCES payment_cases (id),
  import_id           TEXT REFERENCES imports (id),
  type                TEXT NOT NULL CHECK (type IN (
                        'batch_imported', 'batch_submitted', 'provider_status_changed', 'status_observed',
                        'finding_recorded', 'case_opened', 'case_assigned', 'case_state_changed', 'recovery_submitted')),
  source              TEXT NOT NULL CHECK (source IN ('simulation', 'sandbox', 'import', 'operator', 'system')),
  occurred_at         TEXT NOT NULL,
  recorded_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  provider_event_type TEXT,
  previous_status     TEXT,
  new_status          TEXT,
  previous_case_state TEXT,
  new_case_state      TEXT,
  actor_user_id       TEXT REFERENCES users (id),
  summary             TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  CHECK (provider_event_type IS NULL OR source IN ('simulation', 'sandbox'))
) STRICT;

CREATE INDEX payment_events_item ON payment_events (payment_item_id, occurred_at);
CREATE INDEX payment_events_case ON payment_events (case_id, occurred_at);
CREATE INDEX payment_events_organisation ON payment_events (organisation_id, occurred_at DESC);

CREATE TRIGGER payment_events_no_update BEFORE UPDATE ON payment_events
BEGIN
  SELECT RAISE(ABORT, 'payment_events is append-only');
END;

CREATE TRIGGER payment_events_no_delete BEFORE DELETE ON payment_events
BEGIN
  SELECT RAISE(ABORT, 'payment_events is append-only');
END;
