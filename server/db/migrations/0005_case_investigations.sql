-- AI-assisted investigation attempts. Model output is kept here, separate from payment and case records.
-- Each attempt stores the exact evidence pack sent to the model, its fingerprint, the model, the prompt and schema
-- versions and either the validated result or a failure code. Attempts are never deleted; a pending attempt can
-- move to a terminal status once and is then frozen.

CREATE TABLE case_investigations (
  id                    TEXT PRIMARY KEY CHECK (id GLOB 'inv_*'),
  organisation_id       TEXT NOT NULL REFERENCES organisations (id),
  case_id               TEXT NOT NULL REFERENCES payment_cases (id),
  case_version          INTEGER NOT NULL CHECK (case_version >= 1),
  requested_by_user_id  TEXT NOT NULL REFERENCES users (id),
  requested_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  provider              TEXT NOT NULL CHECK (provider IN ('openai')),
  model_requested       TEXT NOT NULL CHECK (length(model_requested) BETWEEN 1 AND 100),
  model_reported        TEXT CHECK (model_reported IS NULL OR length(model_reported) BETWEEN 1 AND 100),
  provider_response_id  TEXT CHECK (provider_response_id IS NULL OR length(provider_response_id) <= 128),
  prompt_version        TEXT NOT NULL,
  schema_version        TEXT NOT NULL,
  evidence_pack         TEXT NOT NULL CHECK (json_valid(evidence_pack)),
  evidence_fingerprint  TEXT NOT NULL CHECK (length(evidence_fingerprint) = 64),
  evidence_count        INTEGER NOT NULL CHECK (evidence_count >= 1),
  evidence_sources      TEXT NOT NULL CHECK (json_valid(evidence_sources)),
  result                TEXT CHECK (result IS NULL OR json_valid(result)),
  failure_code          TEXT CHECK (failure_code IS NULL OR failure_code IN (
                          'timeout', 'rate_limited', 'provider_unavailable', 'provider_rejected_request',
                          'authentication_failed', 'unsupported_schema', 'refused', 'incomplete',
                          'malformed_response', 'failed_validation', 'interrupted')),
  failure_detail        TEXT CHECK (failure_detail IS NULL OR length(failure_detail) <= 300),
  validation_issues     TEXT CHECK (validation_issues IS NULL OR (json_valid(validation_issues) AND json_type(validation_issues) = 'array')),
  input_tokens          INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens         INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  latency_ms            INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  completed_at          TEXT,
  CHECK (
    (status = 'pending'   AND result IS NULL     AND failure_code IS NULL     AND completed_at IS NULL) OR
    (status = 'succeeded' AND result IS NOT NULL AND failure_code IS NULL     AND completed_at IS NOT NULL) OR
    (status = 'failed'    AND result IS NULL     AND failure_code IS NOT NULL AND completed_at IS NOT NULL)
  )
) STRICT;

-- At most one investigation in progress per case.
CREATE UNIQUE INDEX case_investigations_one_pending ON case_investigations (case_id) WHERE status = 'pending';
CREATE INDEX case_investigations_case ON case_investigations (case_id, requested_at);
CREATE INDEX case_investigations_organisation_day ON case_investigations (organisation_id, requested_at);

CREATE TRIGGER case_investigations_no_delete BEFORE DELETE ON case_investigations
BEGIN
  SELECT RAISE(ABORT, 'investigation attempts cannot be deleted');
END;

CREATE TRIGGER case_investigations_complete_once BEFORE UPDATE ON case_investigations
WHEN OLD.status IS NOT 'pending' OR NEW.status = 'pending'
BEGIN
  SELECT RAISE(ABORT, 'an investigation attempt can only move from pending to a final status, once');
END;

CREATE TRIGGER case_investigations_immutable_request BEFORE UPDATE ON case_investigations
WHEN NEW.id IS NOT OLD.id
  OR NEW.organisation_id IS NOT OLD.organisation_id
  OR NEW.case_id IS NOT OLD.case_id
  OR NEW.case_version IS NOT OLD.case_version
  OR NEW.requested_by_user_id IS NOT OLD.requested_by_user_id
  OR NEW.requested_at IS NOT OLD.requested_at
  OR NEW.provider IS NOT OLD.provider
  OR NEW.model_requested IS NOT OLD.model_requested
  OR NEW.prompt_version IS NOT OLD.prompt_version
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.evidence_pack IS NOT OLD.evidence_pack
  OR NEW.evidence_fingerprint IS NOT OLD.evidence_fingerprint
  OR NEW.evidence_count IS NOT OLD.evidence_count
  OR NEW.evidence_sources IS NOT OLD.evidence_sources
BEGIN
  SELECT RAISE(ABORT, 'the request and evidence of an investigation attempt cannot be changed');
END;
