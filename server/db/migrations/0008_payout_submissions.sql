-- Approved reissues sent to PayPal Sandbox as payout batches.
--
-- Exactly one submission exists per approved proposal, and its idempotency keys (sender_batch_id and
-- PayPal-Request-Id) are generated once at approval and can never change. Every send, including replays after
-- an unknown outcome, uses the same keys and the same request body. Replays stop before PayPal's 30-day
-- duplicate-protection window ends: no attempt may be recorded at or after replay_deadline_at.

CREATE TABLE payout_submissions (
  id                  TEXT PRIMARY KEY CHECK (id GLOB 'sub_*'),
  organisation_id     TEXT NOT NULL REFERENCES organisations (id),
  case_id             TEXT NOT NULL REFERENCES payment_cases (id),
  proposal_id         TEXT NOT NULL UNIQUE REFERENCES payout_proposals (id),
  sender_batch_id     TEXT NOT NULL UNIQUE CHECK (sender_batch_id GLOB 'RRS-*' AND length(sender_batch_id) BETWEEN 8 AND 40),
  paypal_request_id   TEXT NOT NULL UNIQUE CHECK (length(paypal_request_id) = 36),
  request_sha256      TEXT NOT NULL CHECK (length(request_sha256) = 64),
  approved_at         TEXT NOT NULL,
  replay_deadline_at  TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN (
                        'prepared', 'sending', 'accepted', 'rejected', 'not_processed', 'outcome_unknown',
                        'blocked_by_policy', 'needs_manual_reconciliation', 'reconciled_not_created')),
  attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 30),
  last_attempt_at     TEXT,
  next_attempt_at     TEXT,
  lease_until         TEXT,
  recovery_batch_id   TEXT REFERENCES payment_batches (id),
  provider_batch_id   TEXT CHECK (provider_batch_id IS NULL OR length(provider_batch_id) BETWEEN 1 AND 64),
  last_http_status    INTEGER,
  last_error_name     TEXT CHECK (last_error_name IS NULL OR length(last_error_name) <= 100),
  last_debug_id       TEXT CHECK (last_debug_id IS NULL OR length(last_debug_id) <= 64),
  accepted_at         TEXT,
  completed_at        TEXT,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (replay_deadline_at = strftime('%Y-%m-%dT%H:%M:%fZ', approved_at, '+25 days')),
  CHECK (last_attempt_at IS NULL OR last_attempt_at < replay_deadline_at),
  CHECK ((state = 'accepted') = (provider_batch_id IS NOT NULL AND recovery_batch_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK (state <> 'sending' OR lease_until IS NOT NULL)
) STRICT;

CREATE INDEX payout_submissions_organisation_day ON payout_submissions (organisation_id, approved_at);
CREATE INDEX payout_submissions_due ON payout_submissions (state, next_attempt_at);

CREATE TRIGGER payout_submissions_require_approval BEFORE INSERT ON payout_submissions
WHEN NOT EXISTS (
  SELECT 1 FROM payout_proposals p
  WHERE p.id = NEW.proposal_id
    AND p.organisation_id = NEW.organisation_id
    AND p.case_id = NEW.case_id
    AND p.action = 'reissue'
    AND p.status = 'approved'
    AND p.decided_by_user_id IS NOT NULL
    AND p.decided_by_user_id <> p.proposed_by_user_id
    AND p.decided_at = NEW.approved_at
)
  OR NEW.state IS NOT 'prepared'
  OR NEW.attempt_count IS NOT 0
BEGIN
  SELECT RAISE(ABORT, 'a submission needs a reissue proposal approved by someone other than its proposer');
END;

CREATE TRIGGER payout_submissions_immutable_keys BEFORE UPDATE ON payout_submissions
WHEN NEW.id IS NOT OLD.id
  OR NEW.organisation_id IS NOT OLD.organisation_id
  OR NEW.case_id IS NOT OLD.case_id
  OR NEW.proposal_id IS NOT OLD.proposal_id
  OR NEW.sender_batch_id IS NOT OLD.sender_batch_id
  OR NEW.paypal_request_id IS NOT OLD.paypal_request_id
  OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.approved_at IS NOT OLD.approved_at
  OR NEW.replay_deadline_at IS NOT OLD.replay_deadline_at
  OR NEW.attempt_count < OLD.attempt_count
  OR NEW.attempt_count > OLD.attempt_count + 1
  OR NEW.version IS NOT OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'submission keys, request and approval time cannot change; attempts only increase by one');
END;

CREATE TRIGGER payout_submissions_final_states BEFORE UPDATE ON payout_submissions
WHEN OLD.state IN ('accepted', 'rejected', 'blocked_by_policy', 'reconciled_not_created')
BEGIN
  SELECT RAISE(ABORT, 'a finished submission cannot be changed');
END;

-- A new attempt is only possible from a state that allows it.
CREATE TRIGGER payout_submissions_attempt_from BEFORE UPDATE ON payout_submissions
WHEN NEW.attempt_count = OLD.attempt_count + 1
  AND (OLD.state NOT IN ('prepared', 'outcome_unknown', 'not_processed') OR NEW.state IS NOT 'sending')
BEGIN
  SELECT RAISE(ABORT, 'a submission attempt can only start from prepared, outcome_unknown or not_processed');
END;

CREATE TRIGGER payout_submissions_no_delete BEFORE DELETE ON payout_submissions
BEGIN
  SELECT RAISE(ABORT, 'submissions cannot be deleted');
END;

-- The single item in each submitted batch. ReliefRelay sends one item per batch.
CREATE TABLE payout_submission_items (
  id                TEXT PRIMARY KEY CHECK (id GLOB 'sbi_*'),
  submission_id     TEXT NOT NULL UNIQUE REFERENCES payout_submissions (id),
  original_item_id  TEXT NOT NULL REFERENCES payment_items (id),
  sender_item_id    TEXT NOT NULL UNIQUE CHECK (length(sender_item_id) BETWEEN 1 AND 63),
  amount_minor      INTEGER NOT NULL CHECK (amount_minor BETWEEN 1 AND 50000),
  currency          TEXT NOT NULL CHECK (currency IN ('GBP', 'USD', 'EUR')),
  recovery_item_id  TEXT UNIQUE REFERENCES payment_items (id),
  provider_item_id  TEXT CHECK (provider_item_id IS NULL OR length(provider_item_id) BETWEEN 1 AND 64)
) STRICT;

CREATE TRIGGER payout_submission_items_set_once BEFORE UPDATE ON payout_submission_items
WHEN NEW.id IS NOT OLD.id
  OR NEW.submission_id IS NOT OLD.submission_id
  OR NEW.original_item_id IS NOT OLD.original_item_id
  OR NEW.sender_item_id IS NOT OLD.sender_item_id
  OR NEW.amount_minor IS NOT OLD.amount_minor
  OR NEW.currency IS NOT OLD.currency
  OR (OLD.recovery_item_id IS NOT NULL AND NEW.recovery_item_id IS NOT OLD.recovery_item_id)
  OR (OLD.provider_item_id IS NOT NULL AND NEW.provider_item_id IS NOT OLD.provider_item_id)
BEGIN
  SELECT RAISE(ABORT, 'a submission item can only gain its recovery and provider IDs, once');
END;

CREATE TRIGGER payout_submission_items_no_delete BEFORE DELETE ON payout_submission_items
BEGIN
  SELECT RAISE(ABORT, 'submission items cannot be deleted');
END;

-- Manual reconciliation of submissions and cancellations whose outcome stayed unknown. Append-only.
CREATE TABLE payout_reconciliations (
  id                TEXT PRIMARY KEY CHECK (id GLOB 'rec_*'),
  organisation_id   TEXT NOT NULL REFERENCES organisations (id),
  submission_id     TEXT REFERENCES payout_submissions (id),
  -- payout_cancellations is created by migration 0009; SQLite resolves the reference when a row is written.
  cancellation_id   TEXT REFERENCES payout_cancellations (id),
  action            TEXT NOT NULL CHECK (action IN ('link_batch', 'record_not_created', 'status_recheck')),
  provider_batch_id TEXT CHECK (provider_batch_id IS NULL OR length(provider_batch_id) BETWEEN 1 AND 64),
  note              TEXT CHECK (note IS NULL OR length(trim(note)) BETWEEN 10 AND 1000),
  user_id           TEXT NOT NULL REFERENCES users (id),
  recorded_at       TEXT NOT NULL,
  CHECK ((submission_id IS NULL) <> (cancellation_id IS NULL)),
  CHECK (action <> 'link_batch' OR (submission_id IS NOT NULL AND provider_batch_id IS NOT NULL)),
  CHECK (action <> 'record_not_created' OR (submission_id IS NOT NULL AND note IS NOT NULL)),
  CHECK (action <> 'status_recheck' OR cancellation_id IS NOT NULL)
) STRICT;

CREATE TRIGGER payout_reconciliations_admin_only BEFORE INSERT ON payout_reconciliations
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND organisation_id = NEW.organisation_id AND role = 'admin')
BEGIN
  SELECT RAISE(ABORT, 'only an administrator can reconcile a payment action');
END;

CREATE TRIGGER payout_reconciliations_not_created_after_window BEFORE INSERT ON payout_reconciliations
WHEN NEW.action = 'record_not_created' AND NOT EXISTS (
  SELECT 1 FROM payout_submissions s
  WHERE s.id = NEW.submission_id
    AND s.state = 'needs_manual_reconciliation'
    AND NEW.recorded_at >= strftime('%Y-%m-%dT%H:%M:%fZ', s.approved_at, '+31 days')
)
BEGIN
  SELECT RAISE(ABORT, 'a submission can only be recorded as not created after manual reconciliation is required and 31 days have passed');
END;

CREATE TRIGGER payout_reconciliations_no_update BEFORE UPDATE ON payout_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'payout_reconciliations is append-only');
END;

CREATE TRIGGER payout_reconciliations_no_delete BEFORE DELETE ON payout_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'payout_reconciliations is append-only');
END;
