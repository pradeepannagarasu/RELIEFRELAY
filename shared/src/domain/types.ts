import type { Money } from './money';
import type { PayoutBatchStatus, PayoutItemStatus, PayoutWebhookEventType } from './paypal';

/** ISO-8601 timestamp in UTC. */
export type IsoDateTime = string;

/**
 * simulation: no external requests; provider events are synthetic.
 * sandbox:    PayPal Payouts Sandbox (test money only).
 * live:       real money. Not supported by this application.
 */
export type ProviderMode = 'simulation' | 'sandbox' | 'live';

export const ROLES = ['admin', 'approver', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export interface Organisation {
  id: string;
  name: string;
  /** True when every record belongs to a fictional demonstration data set. */
  isSynthetic: boolean;
}

export interface User {
  id: string;
  organisationId: string;
  displayName: string;
  email: string;
  role: Role;
}

/** disbursement: the original programme payments. recovery: approved reissues of failed payments. */
export type BatchKind = 'disbursement' | 'recovery';

/**
 * provider_submission: submitted to the payment provider through ReliefRelay, so provider records exist.
 * csv_import:          created from an organisation's CSV export; nothing is known from the provider yet.
 */
export type BatchOrigin = 'provider_submission' | 'csv_import';

export interface PaymentBatch {
  id: string;
  organisationId: string;
  kind: BatchKind;
  origin: BatchOrigin;
  /** Internal, human-readable batch reference. */
  reference: string;
  programme: string;
  /** Idempotency key sent to the provider as sender_batch_header.sender_batch_id; null if never submitted. */
  senderBatchId: string | null;
  /** payout_batch_id returned by the provider; null until submitted. */
  providerBatchId: string | null;
  /** Null when the batch has not been submitted through ReliefRelay. */
  providerMode: ProviderMode | null;
  /** Provider-reported batch status. Null means the provider has reported nothing. */
  status: PayoutBatchStatus | null;
  importedAt: IsoDateTime;
  importedByUserId: string;
  submittedAt: IsoDateTime | null;
  sourceImportId: string | null;
}

export type RecipientType = 'EMAIL' | 'PHONE';

/** What the payment provider reported. Only the provider adapter writes this. */
export interface ProviderRecord {
  mode: Exclude<ProviderMode, 'live'>;
  providerItemId: string | null;
  providerTransactionId: string | null;
  status: PayoutItemStatus;
  errorCode: string | null;
  statusUpdatedAt: IsoDateTime;
}

/**
 * The current status according to the organisation's own imported records. Derived from the most recent
 * status observation; earlier observations are kept unchanged and listed in the case history.
 */
export interface ImportedStatusRecord {
  observationId: string;
  status: PayoutItemStatus;
  /** Status date given in the file, when present. */
  statusAt: IsoDateTime | null;
  errorCode: string | null;
  importId: string;
  rowNumber: number;
  /** When ReliefRelay recorded the observation (database clock). */
  recordedAt: IsoDateTime;
}

export interface PaymentItem {
  id: string;
  batchId: string;
  /** Payment reference. Unique per organisation; sent to the provider as sender_item_id. */
  senderItemId: string;
  /** Programme-issued pseudonymous reference. Names are never stored. */
  recipientReference: string;
  recipientType: RecipientType;
  /** Masked receiver identifier, safe to display. */
  recipientMasked: string;
  amount: Money;
  /** Set when this item is a recovery attempt for an earlier, undelivered item. */
  recoveryOfItemId: string | null;
  provider: ProviderRecord | null;
  imported: ImportedStatusRecord | null;
}

export const CASE_STATES = [
  'open',
  'investigating',
  'awaiting_approval',
  'recovery_submitted',
  'resolved',
  'closed',
] as const;
export type CaseState = (typeof CASE_STATES)[number];

/**
 * Why a case exists:
 * - provider_confirmed:      the provider reported an undelivered or held payment.
 * - imported_record:         the organisation's imported record shows a problem the provider has not confirmed.
 * - reconciliation_conflict: records disagree with each other or may describe a duplicate payment.
 */
export const CASE_BASES = ['provider_confirmed', 'imported_record', 'reconciliation_conflict'] as const;
export type CaseBasis = (typeof CASE_BASES)[number];

export interface CaseResolution {
  kind: 'recovered' | 'closed_no_action';
  summary: string;
  resolvedAt: IsoDateTime;
  resolvedByUserId: string;
  recoveryItemId: string | null;
}

export interface PaymentCase {
  id: string;
  reference: string;
  organisationId: string;
  paymentItemId: string;
  state: CaseState;
  basis: CaseBasis;
  /** Finding code or provider status that caused the case to open. */
  openingReason: string;
  openedAt: IsoDateTime;
  updatedAt: IsoDateTime;
  assigneeUserId: string | null;
  resolution: CaseResolution | null;
  /** Incremented on every change; used to reject updates based on stale data. */
  version: number;
}

/** Who or what produced an event. Provider events are always tagged with the mode they came from. */
export type EventSource = 'simulation' | 'sandbox' | 'import' | 'operator' | 'system';

export type PaymentEventType =
  | 'batch_imported'
  | 'batch_submitted'
  | 'provider_status_changed'
  | 'status_observed'
  | 'finding_recorded'
  | 'case_opened'
  | 'case_assigned'
  | 'case_state_changed'
  | 'recovery_submitted';

export interface PaymentEvent {
  id: string;
  organisationId: string;
  batchId: string;
  paymentItemId: string | null;
  caseId: string | null;
  importId: string | null;
  type: PaymentEventType;
  source: EventSource;
  occurredAt: IsoDateTime;
  providerEventType: PayoutWebhookEventType | null;
  previousStatus: PayoutItemStatus | null;
  newStatus: PayoutItemStatus | null;
  previousCaseState: CaseState | null;
  newCaseState: CaseState | null;
  actorUserId: string | null;
  summary: string;
}

/** Everything known about one organisation's payments at a point in time. */
export interface PaymentDataset {
  organisation: Organisation;
  users: User[];
  batches: PaymentBatch[];
  items: PaymentItem[];
  cases: PaymentCase[];
  events: PaymentEvent[];
}
