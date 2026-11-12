-- PayPal Sandbox webhook deliveries and provider discrepancies.
--
-- Every delivery is recorded with its transmission ID, whether or not its signature verified. Raw bodies are not
-- stored (they contain receiver details); only their SHA-256 and size. Verified events are processed once per
-- event ID. A webhook never sets a payment status directly: processing fetches the authoritative status from
-- PayPal and applies that.

CREATE TABLE paypal_webhook_transmissions (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  transmission_id   TEXT CHECK (transmission_id IS NULL OR length(transmission_id) BETWEEN 1 AND 100),
  event_id          TEXT CHECK (event_id IS NULL OR length(event_id) BETWEEN 1 AND 100),
  event_type        TEXT CHECK (event_type IS NULL OR length(event_type) <= 100),
  verification      TEXT NOT NULL CHECK (verification IN ('verified', 'failed', 'duplicate')),
  failure_code      TEXT CHECK (failure_code IS NULL OR length(failure_code) <= 60),
  body_sha256       TEXT NOT NULL CHECK (length(body_sha256) = 64),
  body_bytes        INTEGER NOT NULL CHECK (body_bytes >= 0),
  cert_host         TEXT CHECK (cert_host IS NULL OR length(cert_host) <= 100),
  transmission_time TEXT,
  received_at       TEXT NOT NULL,
  CHECK ((verification = 'failed') = (failure_code IS NOT NULL))
) STRICT;

-- A verified transmission is accepted once. Failed attempts do not reserve the ID, so a forged request cannot
-- block PayPal's genuine delivery.
CREATE UNIQUE INDEX paypal_webhook_transmissions_verified ON paypal_webhook_transmissions (transmission_id) WHERE verification = 'verified';

CREATE TRIGGER paypal_webhook_transmissions_no_update BEFORE UPDATE ON paypal_webhook_transmissions
BEGIN
  SELECT RAISE(ABORT, 'paypal_webhook_transmissions is append-only');
END;

CREATE TRIGGER paypal_webhook_transmissions_no_delete BEFORE DELETE ON paypal_webhook_transmissions
BEGIN
  SELECT RAISE(ABORT, 'paypal_webhook_transmissions is append-only');
END;

CREATE TABLE paypal_webhook_events (
  event_id               TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 100),
  event_type             TEXT NOT NULL CHECK (length(event_type) <= 100),
  resource_type          TEXT NOT NULL CHECK (resource_type IN ('payout_item', 'payout_batch', 'other')),
  provider_item_id       TEXT CHECK (provider_item_id IS NULL OR length(provider_item_id) <= 64),
  provider_batch_id      TEXT CHECK (provider_batch_id IS NULL OR length(provider_batch_id) <= 64),
  first_transmission_seq INTEGER NOT NULL REFERENCES paypal_webhook_transmissions (seq),
  received_at            TEXT NOT NULL,
  processing_state       TEXT NOT NULL DEFAULT 'pending' CHECK (processing_state IN ('pending', 'processed', 'ignored', 'failed')),
  attempts               INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  processed_at           TEXT,
  last_error             TEXT CHECK (last_error IS NULL OR length(last_error) <= 200)
) STRICT;

CREATE INDEX paypal_webhook_events_pending ON paypal_webhook_events (processing_state, received_at);

CREATE TRIGGER paypal_webhook_events_processing_only BEFORE UPDATE ON paypal_webhook_events
WHEN NEW.event_id IS NOT OLD.event_id
  OR NEW.event_type IS NOT OLD.event_type
  OR NEW.resource_type IS NOT OLD.resource_type
  OR NEW.provider_item_id IS NOT OLD.provider_item_id
  OR NEW.provider_batch_id IS NOT OLD.provider_batch_id
  OR NEW.first_transmission_seq IS NOT OLD.first_transmission_seq
  OR NEW.received_at IS NOT OLD.received_at
  OR OLD.processing_state IN ('processed', 'ignored')
BEGIN
  SELECT RAISE(ABORT, 'only the processing state of a pending webhook event can change');
END;

CREATE TRIGGER paypal_webhook_events_no_delete BEFORE DELETE ON paypal_webhook_events
BEGIN
  SELECT RAISE(ABORT, 'webhook events cannot be deleted');
END;

-- Disagreements between what ReliefRelay sent and what PayPal Sandbox reported. Append-only.
-- An unresolved critical discrepancy blocks payment actions on the payment it concerns.
CREATE TABLE provider_discrepancies (
  id               TEXT PRIMARY KEY CHECK (id GLOB 'dis_*'),
  organisation_id  TEXT NOT NULL REFERENCES organisations (id),
  original_item_id TEXT NOT NULL REFERENCES payment_items (id),
  payment_item_id  TEXT REFERENCES payment_items (id),
  submission_id    TEXT REFERENCES payout_submissions (id),
  code             TEXT NOT NULL CHECK (code IN (
                     'amount_mismatch', 'currency_mismatch', 'currency_conversion', 'malformed_amount', 'unknown_status',
                     'sender_batch_mismatch', 'sender_item_mismatch', 'request_hash_mismatch', 'unexpected_batch_items')),
  severity         TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  expected         TEXT CHECK (expected IS NULL OR length(expected) <= 200),
  actual           TEXT CHECK (actual IS NULL OR length(actual) <= 200),
  recorded_at      TEXT NOT NULL
) STRICT;

CREATE INDEX provider_discrepancies_original ON provider_discrepancies (original_item_id);

CREATE TRIGGER provider_discrepancies_no_update BEFORE UPDATE ON provider_discrepancies
BEGIN
  SELECT RAISE(ABORT, 'provider_discrepancies is append-only');
END;

CREATE TRIGGER provider_discrepancies_no_delete BEFORE DELETE ON provider_discrepancies
BEGIN
  SELECT RAISE(ABORT, 'provider_discrepancies is append-only');
END;

CREATE TABLE provider_discrepancy_resolutions (
  discrepancy_id      TEXT PRIMARY KEY REFERENCES provider_discrepancies (id),
  resolved_by_user_id TEXT NOT NULL REFERENCES users (id),
  note                TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 10 AND 1000),
  resolved_at         TEXT NOT NULL
) STRICT;

CREATE TRIGGER provider_discrepancy_resolutions_admin BEFORE INSERT ON provider_discrepancy_resolutions
WHEN NOT EXISTS (
  SELECT 1 FROM users u JOIN provider_discrepancies d ON d.id = NEW.discrepancy_id
  WHERE u.id = NEW.resolved_by_user_id AND u.organisation_id = d.organisation_id AND u.role = 'admin'
)
BEGIN
  SELECT RAISE(ABORT, 'only an administrator can resolve a discrepancy');
END;

CREATE TRIGGER provider_discrepancy_resolutions_no_update BEFORE UPDATE ON provider_discrepancy_resolutions
BEGIN
  SELECT RAISE(ABORT, 'provider_discrepancy_resolutions is append-only');
END;

CREATE TRIGGER provider_discrepancy_resolutions_no_delete BEFORE DELETE ON provider_discrepancy_resolutions
BEGIN
  SELECT RAISE(ABORT, 'provider_discrepancy_resolutions is append-only');
END;
