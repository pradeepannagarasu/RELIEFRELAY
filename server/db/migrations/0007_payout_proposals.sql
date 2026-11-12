-- Proposed PayPal Sandbox payment actions and their decisions.
--
-- A proposal is made by an operator or administrator and decided by a different approver or administrator.
-- Separation of proposer and approver is enforced here as well as in the service. It separates accounts, not
-- people: in the demo, one person can switch between seeded accounts.

CREATE TABLE payout_proposals (
  id                       TEXT PRIMARY KEY CHECK (id GLOB 'prop_*'),
  organisation_id          TEXT NOT NULL REFERENCES organisations (id),
  case_id                  TEXT NOT NULL REFERENCES payment_cases (id),
  -- The case's payment. Reissues always go to this payment's receiver.
  original_item_id         TEXT NOT NULL REFERENCES payment_items (id),
  action                   TEXT NOT NULL CHECK (action IN ('reissue', 'cancel_unclaimed')),
  -- Reissue: the latest undelivered attempt (the original or an earlier recovery). Cancel: the Sandbox recovery item.
  target_item_id           TEXT NOT NULL REFERENCES payment_items (id),
  attempt_number           INTEGER CHECK (attempt_number IS NULL OR attempt_number BETWEEN 1 AND 3),
  amount_minor             INTEGER NOT NULL CHECK (amount_minor BETWEEN 1 AND 50000),
  currency                 TEXT NOT NULL CHECK (currency IN ('GBP', 'USD', 'EUR')),
  receiver_masked          TEXT NOT NULL,
  allowlist_entry_id       TEXT REFERENCES sandbox_receiver_allowlist (id),
  reason_code              TEXT NOT NULL CHECK (reason_code IN (
                             'returned_unclaimed', 'failed_at_provider', 'previous_recovery_not_delivered',
                             'recipient_cannot_claim', 'programme_team_request')),
  justification            TEXT NOT NULL CHECK (length(trim(justification)) BETWEEN 10 AND 1000),
  attestation              INTEGER NOT NULL CHECK (attestation = 1),
  -- SHA-256 of the provider statuses the proposer saw; approval refuses if they have changed.
  provider_fingerprint     TEXT NOT NULL CHECK (length(provider_fingerprint) = 64),
  status_check_id          TEXT REFERENCES provider_status_checks (id),
  previous_case_state      TEXT NOT NULL CHECK (previous_case_state IN ('open', 'investigating', 'recovery_submitted')),
  case_version             INTEGER NOT NULL CHECK (case_version >= 1),
  proposed_by_user_id      TEXT NOT NULL REFERENCES users (id),
  proposed_at              TEXT NOT NULL,
  expires_at               TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN (
                             'pending_approval', 'approved', 'rejected', 'withdrawn', 'expired', 'superseded')),
  version                  INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  decided_by_user_id       TEXT REFERENCES users (id),
  decided_at               TEXT,
  decision_reason          TEXT CHECK (decision_reason IS NULL OR length(decision_reason) <= 500),
  confirmation_sha256      TEXT CHECK (confirmation_sha256 IS NULL OR length(confirmation_sha256) = 64),
  CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', proposed_at, '+72 hours')),
  CHECK ((action = 'reissue') = (attempt_number IS NOT NULL)),
  CHECK (action <> 'reissue' OR (allowlist_entry_id IS NOT NULL AND previous_case_state IN ('open', 'investigating'))),
  CHECK (action <> 'cancel_unclaimed' OR (previous_case_state = 'recovery_submitted' AND status_check_id IS NOT NULL)),
  CHECK ((status = 'pending_approval') = (decided_at IS NULL)),
  CHECK (status NOT IN ('approved', 'rejected', 'withdrawn') OR decided_by_user_id IS NOT NULL),
  CHECK (status NOT IN ('expired', 'superseded') OR decided_by_user_id IS NULL),
  CHECK ((status = 'approved') = (confirmation_sha256 IS NOT NULL)),
  -- Four-eyes rule: nobody decides their own proposal (withdrawing it is allowed).
  CHECK (status NOT IN ('approved', 'rejected') OR decided_by_user_id <> proposed_by_user_id)
) STRICT;

-- One open proposal per payment, so two people cannot propose conflicting actions at once.
CREATE UNIQUE INDEX payout_proposals_one_open ON payout_proposals (original_item_id) WHERE status = 'pending_approval';
CREATE INDEX payout_proposals_case ON payout_proposals (case_id, proposed_at);
CREATE INDEX payout_proposals_organisation_status ON payout_proposals (organisation_id, status);

CREATE TRIGGER payout_proposals_proposer_role BEFORE INSERT ON payout_proposals
WHEN NOT EXISTS (
  SELECT 1 FROM users WHERE id = NEW.proposed_by_user_id AND organisation_id = NEW.organisation_id AND role IN ('operator', 'admin')
)
BEGIN
  SELECT RAISE(ABORT, 'only an operator or administrator of the organisation can propose a payment action');
END;

CREATE TRIGGER payout_proposals_insert_pending BEFORE INSERT ON payout_proposals
WHEN NEW.status IS NOT 'pending_approval' OR NEW.version IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'a proposal must start as pending approval');
END;

CREATE TRIGGER payout_proposals_decider_role BEFORE UPDATE ON payout_proposals
WHEN NEW.status IN ('approved', 'rejected') AND NOT EXISTS (
  SELECT 1 FROM users WHERE id = NEW.decided_by_user_id AND organisation_id = NEW.organisation_id AND role IN ('approver', 'admin')
)
BEGIN
  SELECT RAISE(ABORT, 'only an approver or administrator of the organisation can decide a payment action');
END;

CREATE TRIGGER payout_proposals_withdrawer BEFORE UPDATE ON payout_proposals
WHEN NEW.status = 'withdrawn' AND NEW.decided_by_user_id IS NOT NEW.proposed_by_user_id AND NOT EXISTS (
  SELECT 1 FROM users WHERE id = NEW.decided_by_user_id AND organisation_id = NEW.organisation_id AND role = 'admin'
)
BEGIN
  SELECT RAISE(ABORT, 'only the proposer or an administrator can withdraw a proposal');
END;

CREATE TRIGGER payout_proposals_decide_once BEFORE UPDATE ON payout_proposals
WHEN OLD.status IS NOT 'pending_approval' OR NEW.version IS NOT OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'a proposal can be decided once, and every change must increment its version by 1');
END;

CREATE TRIGGER payout_proposals_immutable_request BEFORE UPDATE ON payout_proposals
WHEN NEW.id IS NOT OLD.id
  OR NEW.organisation_id IS NOT OLD.organisation_id
  OR NEW.case_id IS NOT OLD.case_id
  OR NEW.original_item_id IS NOT OLD.original_item_id
  OR NEW.action IS NOT OLD.action
  OR NEW.target_item_id IS NOT OLD.target_item_id
  OR NEW.attempt_number IS NOT OLD.attempt_number
  OR NEW.amount_minor IS NOT OLD.amount_minor
  OR NEW.currency IS NOT OLD.currency
  OR NEW.receiver_masked IS NOT OLD.receiver_masked
  OR NEW.allowlist_entry_id IS NOT OLD.allowlist_entry_id
  OR NEW.reason_code IS NOT OLD.reason_code
  OR NEW.justification IS NOT OLD.justification
  OR NEW.attestation IS NOT OLD.attestation
  OR NEW.provider_fingerprint IS NOT OLD.provider_fingerprint
  OR NEW.status_check_id IS NOT OLD.status_check_id
  OR NEW.previous_case_state IS NOT OLD.previous_case_state
  OR NEW.case_version IS NOT OLD.case_version
  OR NEW.proposed_by_user_id IS NOT OLD.proposed_by_user_id
  OR NEW.proposed_at IS NOT OLD.proposed_at
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'the content of a proposal cannot be changed');
END;

CREATE TRIGGER payout_proposals_no_delete BEFORE DELETE ON payout_proposals
BEGIN
  SELECT RAISE(ABORT, 'proposals cannot be deleted');
END;
