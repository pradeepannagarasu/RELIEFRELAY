-- CSV imports, payment batches and items, provider records and imported status observations.
--
-- Three kinds of status are stored separately and never overwrite each other:
--   provider_transactions  what the payment provider reported (written only by the provider adapter)
--   status_observations    what the organisation's imported records said, one append-only row per observation
--   payment_cases.state    ReliefRelay's internal case workflow (migration 0003)

CREATE TABLE imports (
  id                   TEXT PRIMARY KEY,
  organisation_id      TEXT NOT NULL REFERENCES organisations (id),
  file_name            TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  file_sha256          TEXT NOT NULL CHECK (length(file_sha256) = 64),
  file_size_bytes      INTEGER NOT NULL CHECK (file_size_bytes > 0),
  headers              TEXT NOT NULL CHECK (json_valid(headers) AND json_type(headers) = 'array'),
  row_count            INTEGER NOT NULL CHECK (row_count >= 0),
  status               TEXT NOT NULL CHECK (status IN ('draft', 'validated', 'committed', 'discarded')),
  mapping              TEXT CHECK (mapping IS NULL OR json_valid(mapping)),
  validation_version   INTEGER NOT NULL DEFAULT 0 CHECK (validation_version >= 0),
  -- Digest of every row outcome at the current validation version; commit re-checks it.
  plan_digest          TEXT CHECK (plan_digest IS NULL OR length(plan_digest) = 64),
  summary              TEXT CHECK (summary IS NULL OR json_valid(summary)),
  result               TEXT CHECK (result IS NULL OR json_valid(result)),
  is_synthetic         INTEGER NOT NULL CHECK (is_synthetic IN (0, 1)),
  uploaded_by_user_id  TEXT NOT NULL REFERENCES users (id),
  uploaded_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  validated_at         TEXT,
  committed_at         TEXT,
  committed_by_user_id TEXT REFERENCES users (id),
  discarded_at         TEXT,
  CHECK ((status = 'committed') = (committed_at IS NOT NULL AND committed_by_user_id IS NOT NULL AND result IS NOT NULL)),
  CHECK ((status = 'discarded') = (discarded_at IS NOT NULL)),
  CHECK (status NOT IN ('validated', 'committed') OR (mapping IS NOT NULL AND plan_digest IS NOT NULL AND validation_version > 0))
) STRICT;

-- The same file cannot be open twice. A discarded file may be uploaded again.
CREATE UNIQUE INDEX imports_one_live_file ON imports (organisation_id, file_sha256) WHERE status <> 'discarded';
CREATE INDEX imports_organisation_uploaded ON imports (organisation_id, uploaded_at DESC);

CREATE TRIGGER imports_terminal_states BEFORE UPDATE ON imports
WHEN OLD.status IN ('committed', 'discarded')
BEGIN
  SELECT RAISE(ABORT, 'committed and discarded imports cannot be changed');
END;

CREATE TRIGGER imports_immutable_source BEFORE UPDATE ON imports
WHEN NEW.id IS NOT OLD.id
  OR NEW.organisation_id IS NOT OLD.organisation_id
  OR NEW.file_name IS NOT OLD.file_name
  OR NEW.file_sha256 IS NOT OLD.file_sha256
  OR NEW.file_size_bytes IS NOT OLD.file_size_bytes
  OR NEW.headers IS NOT OLD.headers
  OR NEW.row_count IS NOT OLD.row_count
  OR NEW.is_synthetic IS NOT OLD.is_synthetic
  OR NEW.uploaded_by_user_id IS NOT OLD.uploaded_by_user_id
  OR NEW.uploaded_at IS NOT OLD.uploaded_at
  OR NEW.validation_version < OLD.validation_version
BEGIN
  SELECT RAISE(ABORT, 'the uploaded file and its metadata cannot be changed');
END;

CREATE TRIGGER imports_no_delete BEFORE DELETE ON imports
BEGIN
  SELECT RAISE(ABORT, 'imports cannot be deleted; discard them instead');
END;

-- Raw cell values exactly as uploaded (after UTF-8 decoding). Append-only.
CREATE TABLE import_rows (
  id         TEXT PRIMARY KEY,
  import_id  TEXT NOT NULL REFERENCES imports (id),
  -- Spreadsheet row number: the header is row 1.
  row_number INTEGER NOT NULL CHECK (row_number >= 2),
  raw_values TEXT NOT NULL CHECK (json_valid(raw_values) AND json_type(raw_values) = 'array'),
  UNIQUE (import_id, row_number)
) STRICT;

CREATE TRIGGER import_rows_no_update BEFORE UPDATE ON import_rows
BEGIN
  SELECT RAISE(ABORT, 'import_rows is append-only');
END;

CREATE TRIGGER import_rows_no_delete BEFORE DELETE ON import_rows
BEGIN
  SELECT RAISE(ABORT, 'import_rows is append-only');
END;

-- Validation result for each row at each validation version. Re-validating appends a new version.
CREATE TABLE import_row_results (
  import_id          TEXT NOT NULL REFERENCES imports (id),
  validation_version INTEGER NOT NULL CHECK (validation_version >= 1),
  row_number         INTEGER NOT NULL CHECK (row_number >= 2),
  outcome            TEXT NOT NULL CHECK (outcome IN ('new_payment', 'status_update', 'unchanged', 'rejected', 'blank')),
  normalised         TEXT CHECK (normalised IS NULL OR json_valid(normalised)),
  issues             TEXT NOT NULL CHECK (json_valid(issues) AND json_type(issues) = 'array'),
  matched_item_id    TEXT,
  PRIMARY KEY (import_id, validation_version, row_number),
  FOREIGN KEY (import_id, row_number) REFERENCES import_rows (import_id, row_number)
) STRICT;

CREATE TRIGGER import_row_results_no_update BEFORE UPDATE ON import_row_results
BEGIN
  SELECT RAISE(ABORT, 'import_row_results is append-only');
END;

CREATE TRIGGER import_row_results_no_delete BEFORE DELETE ON import_row_results
BEGIN
  SELECT RAISE(ABORT, 'import_row_results is append-only');
END;

CREATE TABLE payment_batches (
  id                 TEXT PRIMARY KEY,
  organisation_id    TEXT NOT NULL REFERENCES organisations (id),
  reference          TEXT NOT NULL CHECK (length(reference) BETWEEN 1 AND 64),
  kind               TEXT NOT NULL CHECK (kind IN ('disbursement', 'recovery')),
  origin             TEXT NOT NULL CHECK (origin IN ('provider_submission', 'csv_import')),
  programme          TEXT NOT NULL CHECK (length(programme) BETWEEN 1 AND 200),
  sender_batch_id    TEXT,
  provider_mode      TEXT CHECK (provider_mode IN ('simulation', 'sandbox')),
  provider_batch_id  TEXT,
  provider_status    TEXT CHECK (provider_status IN ('DENIED', 'PENDING', 'PROCESSING', 'SUCCESS', 'CANCELED')),
  submitted_at       TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users (id),
  source_import_id   TEXT REFERENCES imports (id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (organisation_id, reference),
  CHECK ((origin = 'csv_import') = (source_import_id IS NOT NULL)),
  CHECK (origin = 'provider_submission' OR (provider_mode IS NULL AND provider_status IS NULL AND provider_batch_id IS NULL)),
  CHECK (provider_mode IS NOT 'simulation' OR provider_batch_id IS NULL OR provider_batch_id LIKE 'SIM-%')
) STRICT;

CREATE TRIGGER payment_batches_immutable_identity BEFORE UPDATE ON payment_batches
WHEN NEW.id IS NOT OLD.id
  OR NEW.organisation_id IS NOT OLD.organisation_id
  OR NEW.reference IS NOT OLD.reference
  OR NEW.kind IS NOT OLD.kind
  OR NEW.origin IS NOT OLD.origin
  OR NEW.source_import_id IS NOT OLD.source_import_id
  OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'payment batch identity cannot be changed');
END;

CREATE TRIGGER payment_batches_no_delete BEFORE DELETE ON payment_batches
BEGIN
  SELECT RAISE(ABORT, 'payment batches cannot be deleted');
END;

-- One row per intended payment. Financial details never change once recorded.
CREATE TABLE payment_items (
  id                   TEXT PRIMARY KEY,
  organisation_id      TEXT NOT NULL REFERENCES organisations (id),
  batch_id             TEXT NOT NULL REFERENCES payment_batches (id),
  payment_reference    TEXT NOT NULL CHECK (length(payment_reference) BETWEEN 1 AND 64),
  recipient_reference  TEXT NOT NULL CHECK (length(recipient_reference) BETWEEN 3 AND 40),
  receiver_type        TEXT NOT NULL CHECK (receiver_type IN ('EMAIL', 'PHONE')),
  -- Synthetic test identifier only (validated on import). The API shows receiver_masked instead.
  receiver_value       TEXT NOT NULL CHECK (length(receiver_value) BETWEEN 3 AND 254),
  receiver_masked      TEXT NOT NULL,
  amount_minor         INTEGER NOT NULL CHECK (amount_minor > 0),
  currency             TEXT NOT NULL CHECK (currency IN ('USD', 'EUR', 'GBP')),
  -- SHA-256 of the financial identity; a re-import with the same reference must match it exactly.
  fingerprint          TEXT NOT NULL CHECK (length(fingerprint) = 64),
  recovery_of_item_id  TEXT REFERENCES payment_items (id),
  source_import_row_id TEXT REFERENCES import_rows (id),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (organisation_id, payment_reference),
  CHECK (recovery_of_item_id IS NOT id)
) STRICT;

CREATE INDEX payment_items_batch ON payment_items (batch_id);
CREATE INDEX payment_items_possible_duplicate ON payment_items (organisation_id, batch_id, recipient_reference, amount_minor, currency);
CREATE INDEX payment_items_recovery_of ON payment_items (recovery_of_item_id) WHERE recovery_of_item_id IS NOT NULL;

CREATE TRIGGER payment_items_immutable BEFORE UPDATE ON payment_items
BEGIN
  SELECT RAISE(ABORT, 'payment_items are immutable once recorded');
END;

CREATE TRIGGER payment_items_no_delete BEFORE DELETE ON payment_items
BEGIN
  SELECT RAISE(ABORT, 'payment_items cannot be deleted');
END;

-- Latest provider-reported state of each payment. Every change is also appended to payment_events.
CREATE TABLE provider_transactions (
  payment_item_id         TEXT PRIMARY KEY REFERENCES payment_items (id),
  mode                    TEXT NOT NULL CHECK (mode IN ('simulation', 'sandbox')),
  provider_item_id        TEXT,
  provider_transaction_id TEXT,
  status                  TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED', 'PENDING', 'UNCLAIMED', 'RETURNED', 'ONHOLD', 'BLOCKED', 'REFUNDED', 'REVERSED')),
  error_code              TEXT,
  amount_minor            INTEGER NOT NULL CHECK (amount_minor > 0),
  currency                TEXT NOT NULL CHECK (currency IN ('USD', 'EUR', 'GBP')),
  status_updated_at       TEXT NOT NULL,
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (mode <> 'simulation' OR provider_item_id IS NULL OR provider_item_id LIKE 'SIM-%'),
  CHECK (mode <> 'simulation' OR provider_transaction_id IS NULL OR provider_transaction_id LIKE 'SIM-%')
) STRICT;

CREATE TRIGGER provider_transactions_fixed_item BEFORE UPDATE ON provider_transactions
WHEN NEW.payment_item_id IS NOT OLD.payment_item_id OR NEW.mode IS NOT OLD.mode
BEGIN
  SELECT RAISE(ABORT, 'a provider record cannot move to another payment or mode');
END;

CREATE TRIGGER provider_transactions_no_delete BEFORE DELETE ON provider_transactions
BEGIN
  SELECT RAISE(ABORT, 'provider_transactions cannot be deleted');
END;

-- Every status the organisation's records reported, with its source. Append-only: a later import adds
-- a new observation and never overwrites an earlier one or the provider record.
CREATE TABLE status_observations (
  seq                             INTEGER PRIMARY KEY AUTOINCREMENT,
  id                              TEXT NOT NULL UNIQUE,
  organisation_id                 TEXT NOT NULL REFERENCES organisations (id),
  payment_item_id                 TEXT NOT NULL REFERENCES payment_items (id),
  import_id                       TEXT NOT NULL REFERENCES imports (id),
  import_row_id                   TEXT NOT NULL REFERENCES import_rows (id),
  row_number                      INTEGER NOT NULL CHECK (row_number >= 2),
  status                          TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED', 'PENDING', 'UNCLAIMED', 'RETURNED', 'ONHOLD', 'BLOCKED', 'REFUNDED', 'REVERSED')),
  status_at                       TEXT,
  error_code                      TEXT,
  claimed_provider_item_id        TEXT,
  claimed_provider_transaction_id TEXT,
  recorded_at                     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX status_observations_item ON status_observations (payment_item_id, seq);

CREATE TRIGGER status_observations_no_update BEFORE UPDATE ON status_observations
BEGIN
  SELECT RAISE(ABORT, 'status_observations is append-only');
END;

CREATE TRIGGER status_observations_no_delete BEFORE DELETE ON status_observations
BEGIN
  SELECT RAISE(ABORT, 'status_observations is append-only');
END;
