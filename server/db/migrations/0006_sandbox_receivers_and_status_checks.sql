-- PayPal Sandbox receiver allowlist and the log of provider status checks.
--
-- Payment actions can only reach receivers on this list. Entries are added and deactivated through the
-- server command line only (npm run paypal:receivers); there is no API to change the list. Only reserved,
-- synthetic email addresses are accepted: PayPal Sandbox Payouts is used with EMAIL receivers only.

CREATE TABLE sandbox_receiver_allowlist (
  id                 TEXT PRIMARY KEY CHECK (id GLOB 'rcv_*'),
  organisation_id    TEXT NOT NULL REFERENCES organisations (id),
  receiver_type      TEXT NOT NULL CHECK (receiver_type = 'EMAIL'),
  -- Exact, normalised (lower-case, trimmed) address. Matching is exact; there are no wildcard or domain entries.
  receiver_value     TEXT NOT NULL CHECK (
                       length(receiver_value) BETWEEN 6 AND 254
                       AND receiver_value = lower(trim(receiver_value))
                       AND length(receiver_value) - length(replace(receiver_value, '@', '')) = 1
                       AND instr(receiver_value, '@') > 1
                       AND receiver_value NOT GLOB '*[^a-z0-9.@+_-]*'
                       AND receiver_value NOT GLOB '*..*'
                     ),
  receiver_masked    TEXT NOT NULL,
  label              TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 80),
  added_via          TEXT NOT NULL CHECK (added_via = 'cli'),
  added_at           TEXT NOT NULL,
  deactivated_at     TEXT,
  deactivated_reason TEXT CHECK (deactivated_reason IS NULL OR length(trim(deactivated_reason)) BETWEEN 1 AND 200),
  UNIQUE (organisation_id, receiver_value),
  CHECK ((deactivated_at IS NULL) = (deactivated_reason IS NULL)),
  -- RFC 2606 / RFC 6761 reserved domains only, including PayPal Sandbox's personal.example.com accounts.
  CHECK (
    substr(receiver_value, instr(receiver_value, '@') + 1) IN ('example.com', 'example.org', 'example.net')
    OR substr(receiver_value, instr(receiver_value, '@') + 1) LIKE '%.example.com'
    OR substr(receiver_value, instr(receiver_value, '@') + 1) LIKE '%.example.org'
    OR substr(receiver_value, instr(receiver_value, '@') + 1) LIKE '%.example.net'
    OR substr(receiver_value, instr(receiver_value, '@') + 1) LIKE '%.test'
    OR substr(receiver_value, instr(receiver_value, '@') + 1) LIKE '%.example'
    OR substr(receiver_value, instr(receiver_value, '@') + 1) LIKE '%.invalid'
  )
) STRICT;

CREATE TRIGGER sandbox_receiver_allowlist_deactivate_only BEFORE UPDATE ON sandbox_receiver_allowlist
WHEN OLD.deactivated_at IS NOT NULL
  OR NEW.deactivated_at IS NULL
  OR NEW.id IS NOT OLD.id
  OR NEW.organisation_id IS NOT OLD.organisation_id
  OR NEW.receiver_type IS NOT OLD.receiver_type
  OR NEW.receiver_value IS NOT OLD.receiver_value
  OR NEW.receiver_masked IS NOT OLD.receiver_masked
  OR NEW.label IS NOT OLD.label
  OR NEW.added_via IS NOT OLD.added_via
  OR NEW.added_at IS NOT OLD.added_at
BEGIN
  SELECT RAISE(ABORT, 'an allowlist entry can only be deactivated, once');
END;

CREATE TRIGGER sandbox_receiver_allowlist_no_delete BEFORE DELETE ON sandbox_receiver_allowlist
BEGIN
  SELECT RAISE(ABORT, 'allowlist entries cannot be deleted; deactivate them instead');
END;

-- Every status fetched from PayPal Sandbox, whatever triggered the fetch. Append-only.
CREATE TABLE provider_status_checks (
  id                   TEXT PRIMARY KEY CHECK (id GLOB 'chk_*'),
  organisation_id      TEXT NOT NULL REFERENCES organisations (id),
  payment_item_id      TEXT NOT NULL REFERENCES payment_items (id),
  provider_item_id     TEXT NOT NULL CHECK (length(provider_item_id) BETWEEN 1 AND 64),
  source               TEXT NOT NULL CHECK (source IN ('post_submit', 'poll', 'webhook', 'manual', 'precheck', 'confirm', 'reconcile')),
  outcome              TEXT NOT NULL CHECK (outcome IN ('ok', 'not_found', 'error', 'unrecognised')),
  item_status          TEXT CHECK (item_status IN ('SUCCESS', 'FAILED', 'PENDING', 'UNCLAIMED', 'RETURNED', 'ONHOLD', 'BLOCKED', 'REFUNDED', 'REVERSED')),
  provider_batch_id    TEXT CHECK (provider_batch_id IS NULL OR length(provider_batch_id) <= 64),
  error_name           TEXT CHECK (error_name IS NULL OR length(error_name) <= 100),
  http_status          INTEGER,
  debug_id             TEXT CHECK (debug_id IS NULL OR length(debug_id) <= 64),
  requested_by_user_id TEXT REFERENCES users (id),
  checked_at           TEXT NOT NULL,
  CHECK ((outcome = 'ok') = (item_status IS NOT NULL))
) STRICT;

CREATE INDEX provider_status_checks_item ON provider_status_checks (payment_item_id, checked_at);

CREATE TRIGGER provider_status_checks_no_update BEFORE UPDATE ON provider_status_checks
BEGIN
  SELECT RAISE(ABORT, 'provider_status_checks is append-only');
END;

CREATE TRIGGER provider_status_checks_no_delete BEFORE DELETE ON provider_status_checks
BEGIN
  SELECT RAISE(ABORT, 'provider_status_checks is append-only');
END;
