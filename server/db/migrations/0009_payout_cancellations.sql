-- Approved cancellations of unclaimed PayPal Sandbox recovery payouts.
--
-- Kept separate from batch submissions because PayPal does not document idempotency keys for the cancel
-- endpoint. Safety comes from always fetching the item status first: every send must use a new status check
-- that shows the item as UNCLAIMED, and an unclear outcome is resolved by fetching the status, never by a
-- blind resend. At most three sends are made, all within 24 hours of approval.

CREATE TABLE payout_cancellations (
  id                       TEXT PRIMARY KEY CHECK (id GLOB 'can_*'),
  organisation_id          TEXT NOT NULL REFERENCES organisations (id),
  case_id                  TEXT NOT NULL REFERENCES payment_cases (id),
  proposal_id              TEXT NOT NULL UNIQUE REFERENCES payout_proposals (id),
  target_item_id           TEXT NOT NULL REFERENCES payment_items (id),
  provider_item_id         TEXT NOT NULL CHECK (length(provider_item_id) BETWEEN 1 AND 64),
  approved_at              TEXT NOT NULL,
  send_deadline_at         TEXT NOT NULL,
  state                    TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN (
                             'prepared', 'prechecking', 'sending', 'succeeded', 'already_cancelled', 'not_applicable',
                             'not_processed', 'outcome_unknown', 'needs_manual_reconciliation')),
  send_count               INTEGER NOT NULL DEFAULT 0 CHECK (send_count BETWEEN 0 AND 3),
  last_sent_at             TEXT,
  -- The status check that justified the most recent send. Each send needs a newer one.
  sent_with_check_id       TEXT REFERENCES provider_status_checks (id),
  precheck_status_check_id TEXT REFERENCES provider_status_checks (id),
  last_status_check_id     TEXT REFERENCES provider_status_checks (id),
  resolved_by              TEXT CHECK (resolved_by IS NULL OR resolved_by IN ('cancel_response', 'status_check')),
  lease_until              TEXT,
  next_attempt_at          TEXT,
  last_http_status         INTEGER,
  last_error_name          TEXT CHECK (last_error_name IS NULL OR length(last_error_name) <= 100),
  last_debug_id            TEXT CHECK (last_debug_id IS NULL OR length(last_debug_id) <= 64),
  completed_at             TEXT,
  version                  INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (send_deadline_at = strftime('%Y-%m-%dT%H:%M:%fZ', approved_at, '+24 hours')),
  CHECK (last_sent_at IS NULL OR last_sent_at < send_deadline_at),
  CHECK ((state IN ('succeeded', 'already_cancelled', 'not_applicable')) = (completed_at IS NOT NULL)),
  CHECK (state NOT IN ('succeeded', 'already_cancelled') OR resolved_by IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX payout_cancellations_one_active ON payout_cancellations (target_item_id)
  WHERE state NOT IN ('succeeded', 'already_cancelled', 'not_applicable');

CREATE TRIGGER payout_cancellations_require_approval BEFORE INSERT ON payout_cancellations
WHEN NOT EXISTS (
  SELECT 1 FROM payout_proposals p
  WHERE p.id = NEW.proposal_id
    AND p.organisation_id = NEW.organisation_id
    AND p.case_id = NEW.case_id
    AND p.target_item_id = NEW.target_item_id
    AND p.action = 'cancel_unclaimed'
    AND p.status = 'approved'
    AND p.decided_by_user_id IS NOT NULL
    AND p.decided_by_user_id <> p.proposed_by_user_id
    AND p.decided_at = NEW.approved_at
)
  OR NEW.state IS NOT 'prepared'
  OR NEW.send_count IS NOT 0
BEGIN
  SELECT RAISE(ABORT, 'a cancellation needs a cancellation proposal approved by someone other than its proposer');
END;

-- Moving to sending requires a new status check, for this item, that showed it as UNCLAIMED.
CREATE TRIGGER payout_cancellations_send_after_precheck BEFORE UPDATE ON payout_cancellations
WHEN NEW.state = 'sending' AND OLD.state IS NOT 'sending' AND (
  NEW.precheck_status_check_id IS NULL
  OR NEW.precheck_status_check_id IS OLD.sent_with_check_id
  OR NEW.sent_with_check_id IS NOT NEW.precheck_status_check_id
  OR NEW.send_count IS NOT OLD.send_count + 1
  OR NEW.lease_until IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM provider_status_checks c
    WHERE c.id = NEW.precheck_status_check_id
      AND c.payment_item_id = NEW.target_item_id
      AND c.outcome = 'ok'
      AND c.item_status = 'UNCLAIMED'
      AND c.checked_at >= coalesce(OLD.last_sent_at, OLD.approved_at)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'a cancellation can only be sent after a new status check shows the item as UNCLAIMED');
END;

CREATE TRIGGER payout_cancellations_send_count_only_on_send BEFORE UPDATE ON payout_cancellations
WHEN NEW.send_count IS NOT OLD.send_count AND NOT (NEW.state = 'sending' AND OLD.state IS NOT 'sending')
BEGIN
  SELECT RAISE(ABORT, 'the send count only changes when a cancellation is sent');
END;

CREATE TRIGGER payout_cancellations_immutable BEFORE UPDATE ON payout_cancellations
WHEN NEW.id IS NOT OLD.id
  OR NEW.organisation_id IS NOT OLD.organisation_id
  OR NEW.case_id IS NOT OLD.case_id
  OR NEW.proposal_id IS NOT OLD.proposal_id
  OR NEW.target_item_id IS NOT OLD.target_item_id
  OR NEW.provider_item_id IS NOT OLD.provider_item_id
  OR NEW.approved_at IS NOT OLD.approved_at
  OR NEW.send_deadline_at IS NOT OLD.send_deadline_at
  OR NEW.version IS NOT OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'the target and approval of a cancellation cannot change');
END;

CREATE TRIGGER payout_cancellations_final_states BEFORE UPDATE ON payout_cancellations
WHEN OLD.state IN ('succeeded', 'already_cancelled', 'not_applicable')
BEGIN
  SELECT RAISE(ABORT, 'a finished cancellation cannot be changed');
END;

CREATE TRIGGER payout_cancellations_no_delete BEFORE DELETE ON payout_cancellations
BEGIN
  SELECT RAISE(ABORT, 'cancellations cannot be deleted');
END;
