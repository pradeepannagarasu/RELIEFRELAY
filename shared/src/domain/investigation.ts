import type { InvestigationOutput } from './investigationSchema';
import type { PayoutItemStatus } from './paypal';

/**
 * AI-assisted investigation. The model receives a minimised evidence pack built from an explicit allowlist of
 * normalised fields and returns a structured analysis. Every factual statement must cite evidence items by ID.
 * ReliefRelay checks the output against the evidence before storing it; that check establishes source grounding,
 * not that the model's reasoning is correct.
 */

export const INVESTIGATION_PROMPT_VERSION = 'investigation-prompt-v3';
export const INVESTIGATION_SCHEMA_VERSION = 'investigation-output-v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-6.1-sol';

/* ---------- Evidence ---------- */

/** Where a piece of evidence comes from. Statements must name the origin they rely on. */
export const EVIDENCE_ORIGINS = [
  'provider_simulation',
  'provider_sandbox',
  'imported',
  'reconciliation_rule',
  'reliefrelay_record',
  'reference_rule',
  'derived',
] as const;
export type EvidenceOrigin = (typeof EVIDENCE_ORIGINS)[number];

export const EVIDENCE_KINDS = [
  'case',
  'payment',
  'batch',
  'provider_record',
  'imported_status',
  'finding',
  'event',
  'recovery_payment',
  'reference_rule',
  'derived_value',
  'conflict',
  'gap',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export type EvidenceValue = string | number | boolean | null | string[];

/** One item in the evidence pack sent to the model. Only allowlisted, normalised fields appear in `fields`. */
export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  origin: EvidenceOrigin;
  fields: Record<string, EvidenceValue>;
}

export interface EvidencePack {
  packVersion: string;
  /** Reference time for derived day counts. */
  asOf: string;
  /** Categories of information that exist in ReliefRelay but are deliberately withheld from the model. */
  withheld: string[];
  evidence: EvidenceItem[];
}

export const EVIDENCE_PACK_VERSION = 'evidence-pack-v1';

export const WITHHELD_CATEGORIES = [
  'receiver email addresses and phone numbers',
  'recipient references',
  'recipient and beneficiary names',
  'raw CSV rows and source cells',
  'uploaded file names',
  'operator notes',
  'programme names',
  'user names and audit records',
] as const;

/* ---------- Model output ---------- */

/**
 * Which kind of source a factual statement relies on. A statement may only cite evidence of the matching origin,
 * so imported records can never be presented as provider records.
 */
export const STATEMENT_BASES = ['provider_record', 'imported_record', 'reconciliation_rule', 'reliefrelay_record', 'reference_rule', 'derived'] as const;
export type StatementBasis = (typeof STATEMENT_BASES)[number];

export const BASIS_ORIGINS: Record<StatementBasis, readonly EvidenceOrigin[]> = {
  provider_record: ['provider_simulation', 'provider_sandbox'],
  imported_record: ['imported'],
  reconciliation_rule: ['reconciliation_rule'],
  reliefrelay_record: ['reliefrelay_record'],
  reference_rule: ['reference_rule'],
  derived: ['derived'],
};

export const UNKNOWN_KINDS = ['missing_information', 'conflicting_records', 'outcome_not_final', 'cannot_be_established'] as const;
export type UnknownKind = (typeof UNKNOWN_KINDS)[number];

export const POSSIBILITY_CATEGORIES = [
  'recipient_has_not_claimed',
  'receiver_account_issue',
  'provider_hold_or_review',
  'provider_processing_delay',
  'imported_record_out_of_date',
  'data_entry_or_export_error',
  'duplicate_entry',
  'payment_reversed_or_refunded',
  'other',
] as const;
export type PossibilityCategory = (typeof POSSIBILITY_CATEGORIES)[number];

/**
 * Statuses that can support each kind of explanation. A citation of any other status as support is rejected:
 * a real SUCCESS status cannot be cited as evidence that the recipient failed to claim the payment.
 * Categories without an entry accept any status.
 */
export const CATEGORY_SUPPORTING_STATUSES: Partial<Record<PossibilityCategory, readonly PayoutItemStatus[]>> = {
  recipient_has_not_claimed: ['UNCLAIMED', 'RETURNED'],
  receiver_account_issue: ['FAILED', 'BLOCKED', 'RETURNED', 'UNCLAIMED'],
  provider_hold_or_review: ['ONHOLD', 'BLOCKED', 'PENDING'],
  provider_processing_delay: ['PENDING', 'ONHOLD'],
  payment_reversed_or_refunded: ['REFUNDED', 'REVERSED'],
};

export const NEXT_STEP_TYPES = [
  'verify_record',
  'compare_records',
  'check_provider_status',
  'request_information_from_programme_team',
  'wait_for_outcome',
  'propose_reissue',
  'propose_cancellation',
  'compliance_review',
  'record_conclusion_in_notes',
] as const;
export type NextStepType = (typeof NEXT_STEP_TYPES)[number];

/** Steps that would lead to a financial action. They always need explicit human authorisation in ReliefRelay. */
export const STEPS_REQUIRING_AUTHORISATION: readonly NextStepType[] = ['propose_reissue', 'propose_cancellation', 'compliance_review'];

export type { InvestigationOutput };


/* ---------- Stored attempts ---------- */

export const INVESTIGATION_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type InvestigationStatus = (typeof INVESTIGATION_STATUSES)[number];

export const INVESTIGATION_FAILURE_CODES = [
  'timeout',
  'rate_limited',
  'provider_unavailable',
  'provider_rejected_request',
  'authentication_failed',
  'unsupported_schema',
  'refused',
  'incomplete',
  'malformed_response',
  'failed_validation',
  'interrupted',
] as const;
export type InvestigationFailureCode = (typeof INVESTIGATION_FAILURE_CODES)[number];

export const FAILURE_INFO: Record<InvestigationFailureCode, { label: string; description: string }> = {
  timeout: { label: 'Timed out', description: 'The AI provider did not respond within the time limit. Nothing was stored from this attempt.' },
  rate_limited: { label: 'Provider rate limit', description: 'The AI provider asked ReliefRelay to slow down. Wait before trying again.' },
  provider_unavailable: { label: 'Provider unavailable', description: 'The AI provider could not be reached or returned a server error.' },
  provider_rejected_request: { label: 'Request rejected', description: 'The AI provider rejected the request. Check the server configuration.' },
  authentication_failed: { label: 'Not authorised', description: 'The AI provider did not accept the server’s API key.' },
  unsupported_schema: { label: 'Output format not supported', description: 'The configured model did not accept the structured output format.' },
  refused: { label: 'Model declined', description: 'The model declined to analyse this case.' },
  incomplete: { label: 'Incomplete response', description: 'The model stopped before finishing its analysis, so none of it was kept.' },
  malformed_response: { label: 'Unreadable response', description: 'The response did not match the required format, so none of it was kept.' },
  failed_validation: {
    label: 'Rejected by evidence checks',
    description: 'The analysis made at least one statement the evidence does not support, so the whole response was rejected.',
  },
  interrupted: { label: 'Interrupted', description: 'The server stopped before the attempt finished.' },
};

export interface ValidationIssue {
  code: string;
  /** Location in the model output, e.g. known[2].statement. Never contains output text. */
  path: string;
  message: string;
}

/** A next step as shown to operators, with flags set by ReliefRelay rather than the model. */
export interface PresentedNextStep {
  id: string;
  type: NextStepType;
  action: string;
  relatesTo: string[];
  informationNeeded: string | null;
  requiresHumanAuthorisation: boolean;
}

export interface InvestigationResult extends Omit<InvestigationOutput, 'nextSteps'> {
  nextSteps: PresentedNextStep[];
}

export const NEXT_STEP_LABELS: Record<NextStepType, string> = {
  verify_record: 'Verify a record',
  compare_records: 'Compare records',
  check_provider_status: 'Check provider status',
  request_information_from_programme_team: 'Ask the programme team',
  wait_for_outcome: 'Wait for an outcome',
  propose_reissue: 'Consider proposing a reissue',
  propose_cancellation: 'Consider proposing a cancellation',
  compliance_review: 'Compliance review',
  record_conclusion_in_notes: 'Record conclusion in notes',
};

export const UNKNOWN_KIND_LABELS: Record<UnknownKind, string> = {
  missing_information: 'Missing information',
  conflicting_records: 'Conflicting records',
  outcome_not_final: 'Outcome not final',
  cannot_be_established: 'Cannot be established',
};

export const POSSIBILITY_LABELS: Record<PossibilityCategory, string> = {
  recipient_has_not_claimed: 'Payment not yet claimed',
  receiver_account_issue: 'Receiver account issue',
  provider_hold_or_review: 'Provider hold or review',
  provider_processing_delay: 'Provider processing delay',
  imported_record_out_of_date: 'Imported record out of date',
  data_entry_or_export_error: 'Data entry or export error',
  duplicate_entry: 'Duplicate entry',
  payment_reversed_or_refunded: 'Reversed or refunded',
  other: 'Other',
};

export const BASIS_LABELS: Record<StatementBasis, string> = {
  provider_record: 'Provider record',
  imported_record: 'Imported record',
  reconciliation_rule: 'Reconciliation rule',
  reliefrelay_record: 'ReliefRelay record',
  reference_rule: 'Reference rule',
  derived: 'Calculated by ReliefRelay',
};
