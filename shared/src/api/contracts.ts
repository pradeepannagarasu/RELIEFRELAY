import type { NextAction } from '../domain/cases';
import type { FindingCode, FindingSeverity } from '../domain/findings';
import type { ColumnMapping, ImportStatus, RowIssue, RowIssueCode, RowOutcome } from '../domain/imports';
import type {
  EvidenceItem,
  InvestigationFailureCode,
  InvestigationResult,
  InvestigationStatus,
  ValidationIssue,
} from '../domain/investigation';
import type { Money, MoneyTotals } from '../domain/money';
import type { Overview } from '../domain/overview';
import type { PayoutBatchStatus, PayoutItemStatus } from '../domain/paypal';
import type {
  CancellationState,
  DiscrepancyCode,
  PayoutCurrency,
  PayPalTarget,
  ProposalAction,
  ProposalReasonCode,
  ProposalStatus,
  StatusCheckSource,
  SubmissionState,
} from '../domain/payouts';
import type { ReportedStatus } from '../domain/status';
import type {
  BatchKind,
  BatchOrigin,
  CaseBasis,
  CaseState,
  ImportedStatusRecord,
  IsoDateTime,
  Organisation,
  PaymentEvent,
  ProviderMode,
  ProviderRecord,
  RecipientType,
  Role,
} from '../domain/types';

/** Structured error body returned by every failing API request. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

export interface IntegrationStatus {
  configured: boolean;
  /** Plain-language explanation shown to operators. Never contains secrets. */
  detail: string;
}

export interface SessionResponse {
  user: { id: string; displayName: string; role: Role };
  organisation: Organisation;
  environment: {
    providerMode: ProviderMode;
    authMode: 'demo';
    paypal: IntegrationStatus;
    ai: IntegrationStatus;
    database: IntegrationStatus;
    version: string;
    /** Development-only role demonstration switcher is active. Not authentication. */
    demoRoleSwitcher: boolean;
    /** Where PayPal requests go: the real PayPal Sandbox API or a local stub (development and tests only). */
    paypalTarget: PayPalTarget;
    /** The request came through the public demonstration gateway: read-only, acting as the viewer account. */
    publicReadOnly: boolean;
    /** The public Judge Demo: an isolated database whose payment actions go only to the local PayPal stub. */
    judgeDemo: boolean;
  };
}

export interface UserRef {
  id: string;
  displayName: string;
}

/* ---------- Imports ---------- */

export interface ImportSummary {
  dataRows: number;
  outcomes: Record<RowOutcome, number>;
  /** Number of rows with each issue. */
  issueCounts: Partial<Record<RowIssueCode, number>>;
  /** Importable rows that carry at least one warning. */
  rowsWithWarnings: number;
  newBatchReferences: string[];
  newPaymentValue: MoneyTotals;
  /** Rows whose findings will open a case or be added to an active one. */
  rowsRaisingFindings: number;
}

export interface ImportResult {
  newPayments: number;
  statusObservations: number;
  unchanged: number;
  rejected: number;
  findingsRecorded: number;
  batchesCreated: { id: string; reference: string }[];
  casesOpened: { id: string; reference: string }[];
  casesUpdated: { id: string; reference: string }[];
}

export interface ImportListItem {
  id: string;
  fileName: string;
  status: ImportStatus;
  rowCount: number;
  isSynthetic: boolean;
  uploadedAt: IsoDateTime;
  uploadedBy: UserRef;
  committedAt: IsoDateTime | null;
  summary: ImportSummary | null;
  result: ImportResult | null;
}

export interface ImportDetail extends ImportListItem {
  sizeBytes: number;
  fileSha256: string;
  headers: string[];
  mapping: ColumnMapping | null;
  suggestedMapping: ColumnMapping;
  validationVersion: number;
  validatedAt: IsoDateTime | null;
  committedBy: UserRef | null;
  discardedAt: IsoDateTime | null;
  /** The first rows exactly as uploaded, for checking the column mapping. */
  previewRows: { rowNumber: number; values: string[] }[];
}

export interface UploadImportResponse {
  import: ImportDetail;
  /** True when this exact file was already uploaded; the existing import is returned and nothing new is stored. */
  alreadyUploaded: boolean;
}

export interface ImportRowView {
  rowNumber: number;
  values: string[];
  outcome: RowOutcome;
  issues: RowIssue[];
  normalised: {
    paymentReference: string;
    batchReference: string;
    recipientReference: string;
    amount: Money;
    receiverType: RecipientType;
    receiverMasked: string;
    recordedStatus: PayoutItemStatus | null;
    statusAt: IsoDateTime | null;
  } | null;
  matchedPaymentId: string | null;
}

export interface ImportRowsResponse {
  rows: ImportRowView[];
  page: number;
  pageSize: number;
  total: number;
  validationVersion: number;
}

export interface ImportListResponse {
  imports: ImportListItem[];
}

export interface CommitImportResponse {
  import: ImportDetail;
  alreadyCommitted: boolean;
}

/* ---------- Cases ---------- */

export interface CaseListItem {
  id: string;
  reference: string;
  state: CaseState;
  basis: CaseBasis;
  openingReason: string;
  openedAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
  payment: {
    id: string;
    reference: string;
    recipientReference: string;
    amount: Money;
    batchId: string;
    batchReference: string;
  };
  /** Provider status when the provider has reported one, otherwise the imported status (labelled as such). */
  status: ReportedStatus | null;
  nextAction: NextAction;
  assignee: UserRef | null;
}

export const CASE_SORT_FIELDS = ['opened', 'updated', 'amount', 'reference', 'due'] as const;
export type CaseSortField = (typeof CASE_SORT_FIELDS)[number];

export interface CaseListResponse {
  cases: CaseListItem[];
  page: number;
  pageSize: number;
  total: number;
  batches: { id: string; reference: string }[];
}

export interface FindingView {
  id: string;
  code: FindingCode;
  severity: FindingSeverity;
  detail: string;
  expected: unknown;
  actual: unknown;
  relatedPayments: { id: string; reference: string }[];
  import: { id: string; fileName: string; rowNumber: number } | null;
  ruleVersion: number;
  recordedAt: IsoDateTime;
}

export interface ObservationView extends ImportedStatusRecord {
  fileName: string;
  isCurrent: boolean;
}

export interface TimelineEvent extends PaymentEvent {
  actorName: string | null;
}

export interface NoteView {
  id: string;
  body: string;
  author: UserRef;
  createdAt: IsoDateTime;
}

export interface AuditEntryView {
  seq: number;
  recordedAt: IsoDateTime;
  action: string;
  outcome: 'succeeded' | 'rejected';
  actor: (UserRef & { role: Role }) | null;
  previousState: unknown;
  newState: unknown;
  reason: string | null;
}

export interface CaseDetail {
  case: {
    id: string;
    reference: string;
    state: CaseState;
    basis: CaseBasis;
    openingReason: string;
    openedAt: IsoDateTime;
    updatedAt: IsoDateTime;
    version: number;
    assignee: UserRef | null;
    resolution: { kind: 'recovered' | 'closed_no_action'; summary: string; resolvedAt: IsoDateTime; resolvedBy: UserRef | null } | null;
  };
  nextAction: NextAction;
  payment: {
    id: string;
    reference: string;
    recipientReference: string;
    recipientType: RecipientType;
    recipientMasked: string;
    amount: Money;
    recordedAt: IsoDateTime;
    recoveryOf: { id: string; reference: string } | null;
  };
  batch: {
    id: string;
    reference: string;
    programme: string;
    kind: BatchKind;
    origin: BatchOrigin;
    providerMode: ProviderMode | null;
    status: PayoutBatchStatus | null;
    submittedAt: IsoDateTime | null;
  };
  provider: ProviderRecord | null;
  imported: ObservationView | null;
  observations: ObservationView[];
  recoveries: { id: string; reference: string; amount: Money; providerStatus: PayoutItemStatus | null }[];
  findings: FindingView[];
  timeline: TimelineEvent[];
  notes: NoteView[];
  history: AuditEntryView[];
  sourceRow: { importId: string; fileName: string; rowNumber: number; headers: string[]; values: string[] } | null;
  permissions: { canAssign: boolean; canAddNote: boolean };
}

export interface CaseMutationResponse {
  case: CaseDetail;
}

/* ---------- AI-assisted investigation ---------- */

export interface InvestigationSummary {
  id: string;
  status: InvestigationStatus;
  requestedAt: IsoDateTime;
  completedAt: IsoDateTime | null;
  requestedBy: UserRef;
  /** The model the provider reported, or the requested model when it reported none. */
  model: string;
  promptVersion: string;
  caseVersion: number;
  evidenceCount: number;
  evidenceFingerprint: string;
  /** True when the case's evidence differs from the snapshot this attempt used. */
  evidenceChanged: boolean;
  failure: { code: InvestigationFailureCode; label: string; description: string; detail: string | null } | null;
}

/** The ReliefRelay record an evidence item came from. Not part of the snapshot sent to the model. */
export interface EvidenceSourceRef {
  type: 'case' | 'payment' | 'batch' | 'provider_record' | 'observation' | 'finding' | 'event';
  id: string;
}

export interface EvidenceItemView extends EvidenceItem {
  source: EvidenceSourceRef | null;
}

export interface InvestigationDetail extends InvestigationSummary {
  /** Validated analysis; null when the attempt failed. */
  result: InvestigationResult | null;
  validationIssues: ValidationIssue[];
  /** The exact evidence snapshot sent to the model. */
  evidence: EvidenceItemView[];
  evidenceAsOf: IsoDateTime;
  withheld: string[];
  usage: { inputTokens: number | null; outputTokens: number | null; latencyMs: number | null };
}

export interface InvestigationListResponse {
  availability: {
    configured: boolean;
    model: string | null;
    canRun: boolean;
    /** Why the current user cannot run an investigation now, if they cannot. */
    reason: string | null;
    dailyLimit: number;
    usedToday: number;
  };
  current: { evidenceFingerprint: string; evidenceCount: number };
  investigations: InvestigationSummary[];
  /** Most recent successful analysis, shown even when a later attempt failed. */
  latestSucceeded: InvestigationDetail | null;
}

export interface RunInvestigationRequest {
  caseVersion: number;
}

/* ---------- PayPal Sandbox payment actions ---------- */

export const PAYMENT_ACTION_BLOCK_CODES = [
  'simulation_mode',
  'not_configured',
  'payouts_disabled',
  'case_not_active',
  'manual_reconciliation_required',
  'discrepancy_unresolved',
  'submission_in_progress',
  'cancellation_in_progress',
  'proposal_open',
] as const;
export type PaymentActionBlockCode = (typeof PAYMENT_ACTION_BLOCK_CODES)[number];

/** A reason no payment action can be proposed or approved for this payment right now. */
export interface PaymentActionBlock {
  code: PaymentActionBlockCode;
  message: string;
}

export interface StatusCheckView {
  id: string;
  source: StatusCheckSource;
  outcome: 'ok' | 'not_found' | 'error' | 'unrecognised';
  itemStatus: PayoutItemStatus | null;
  errorName: string | null;
  httpStatus: number | null;
  debugId: string | null;
  checkedAt: IsoDateTime;
  requestedBy: UserRef | null;
}

/** One payment attempt: the case's original payment or a recovery of it. */
export interface PaymentAttemptView {
  itemId: string;
  reference: string;
  kind: 'original' | 'recovery';
  attemptNumber: number | null;
  amount: Money;
  receiverMasked: string;
  /** The individual item's provider record. Separate from the batch status below. */
  provider: ProviderRecord | null;
  batch: {
    id: string;
    reference: string;
    providerMode: ProviderMode | null;
    providerBatchId: string | null;
    status: PayoutBatchStatus | null;
    submittedAt: IsoDateTime | null;
  };
  latestCheck: StatusCheckView | null;
  /** Whether latestCheck is recent enough to justify an action. */
  checkFresh: boolean;
}

export interface LimitUsage {
  currency: PayoutCurrency;
  payoutsToday: number;
  maxPayoutsPerDay: number;
  valueTodayMinor: number;
  maxValuePerCurrencyPerDayMinor: number;
  maxPerPayoutMinor: number;
}

export interface ProposalSummary {
  id: string;
  caseId: string;
  caseReference: string;
  paymentReference: string;
  action: ProposalAction;
  status: ProposalStatus;
  amount: Money;
  receiverMasked: string;
  attemptNumber: number | null;
  reasonCode: ProposalReasonCode;
  proposedBy: UserRef;
  proposedAt: IsoDateTime;
  expiresAt: IsoDateTime;
  decidedBy: UserRef | null;
  decidedAt: IsoDateTime | null;
  version: number;
}

export interface SubmissionView {
  id: string;
  proposalId: string;
  state: SubmissionState;
  senderBatchId: string;
  senderItemId: string;
  approvedAt: IsoDateTime;
  attemptCount: number;
  maxAttempts: number;
  lastAttemptAt: IsoDateTime | null;
  nextAttemptAt: IsoDateTime | null;
  replayDeadlineAt: IsoDateTime;
  providerBatchId: string | null;
  lastHttpStatus: number | null;
  lastErrorName: string | null;
  lastDebugId: string | null;
  acceptedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  recoveryItem: { id: string; reference: string } | null;
}

export interface CancellationView {
  id: string;
  proposalId: string;
  state: CancellationState;
  targetItem: { id: string; reference: string };
  providerItemId: string;
  approvedAt: IsoDateTime;
  sendCount: number;
  maxSends: number;
  lastSentAt: IsoDateTime | null;
  sendDeadlineAt: IsoDateTime;
  resolvedBy: 'cancel_response' | 'status_check' | null;
  lastHttpStatus: number | null;
  lastErrorName: string | null;
  completedAt: IsoDateTime | null;
}

export interface DiscrepancyView {
  id: string;
  code: DiscrepancyCode;
  severity: 'warning' | 'critical';
  description: string;
  expected: string | null;
  actual: string | null;
  recordedAt: IsoDateTime;
  payment: { id: string; reference: string } | null;
  resolution: { by: UserRef; note: string; resolvedAt: IsoDateTime } | null;
}

export interface ReconciliationView {
  id: string;
  action: 'link_batch' | 'record_not_created' | 'status_recheck';
  submissionId: string | null;
  cancellationId: string | null;
  providerBatchId: string | null;
  note: string | null;
  by: UserRef;
  recordedAt: IsoDateTime;
}

export interface ActionOption {
  available: boolean;
  /** Why the action is not available, in plain language. Empty when available. */
  reasons: string[];
  /** The server fetches the item status from PayPal Sandbox before recording the proposal. */
  statusCheckRequired: boolean;
  reasonCodes: ProposalReasonCode[];
}

export interface PaymentActionsResponse {
  sandboxNotice: string;
  providerMode: ProviderMode;
  /** Sandbox mode, credentials configured and payment actions switched on for this server. */
  enabled: boolean;
  blocks: PaymentActionBlock[];
  case: { id: string; reference: string; state: CaseState; version: number };
  original: PaymentAttemptView;
  recoveries: PaymentAttemptView[];
  /** Pass back when proposing; the server refuses if provider statuses changed in between. */
  providerFingerprint: string;
  reissue: ActionOption & {
    attemptNumber: number | null;
    amount: Money;
    receiverMasked: string;
    senderItemId: string | null;
    /** True when the original receiver is an exact, active entry on the Sandbox receiver allowlist. */
    receiverAllowlisted: boolean;
  };
  cancel: ActionOption & { target: { id: string; reference: string } | null };
  openProposal: ProposalSummary | null;
  proposals: ProposalSummary[];
  submissions: SubmissionView[];
  cancellations: CancellationView[];
  discrepancies: DiscrepancyView[];
  reconciliations: ReconciliationView[];
  limits: LimitUsage | null;
  permissions: { canPropose: boolean; canCheckStatus: boolean; canReconcile: boolean };
}

export interface CreateProposalRequest {
  action: ProposalAction;
  reasonCode: ProposalReasonCode;
  justification: string;
  attestation: true;
  caseVersion: number;
  providerFingerprint: string;
}

export interface ApproveProposalRequest {
  proposalVersion: number;
  confirmation: string;
}

export interface DecideProposalRequest {
  proposalVersion: number;
  reason: string;
}

export interface ServerCheck {
  code: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface ProposalDetail extends ProposalSummary {
  justification: string;
  decisionReason: string | null;
  target: { id: string; reference: string };
  caseState: CaseState;
  previousCaseState: CaseState;
  caseVersion: number;
  /** The exact text the approver must type. */
  confirmationPhrase: string;
  /** Server-side checks evaluated now. Approval re-runs them all. */
  checks: ServerCheck[];
  limits: LimitUsage | null;
  attempts: PaymentAttemptView[];
  submission: SubmissionView | null;
  cancellation: CancellationView | null;
  permissions: { canApprove: boolean; canReject: boolean; canWithdraw: boolean; reason: string | null };
  history: AuditEntryView[];
  sandboxNotice: string;
}

export interface ProposalListResponse {
  proposals: ProposalSummary[];
  counts: Record<ProposalStatus, number>;
}

export interface ProposalResponse {
  proposal: ProposalDetail;
}

export interface StatusCheckResponse {
  check: StatusCheckView;
  actions: PaymentActionsResponse;
}

export interface ReconcileRequest {
  action: 'link_batch' | 'record_not_created' | 'status_recheck';
  providerBatchId?: string;
  note?: string;
}

export interface ResolveDiscrepancyRequest {
  note: string;
}

export interface PayPalIntegrationResponse {
  sandboxNotice: string;
  /** Where PayPal requests go: the real PayPal Sandbox API or a local stub. */
  target: PayPalTarget;
  providerMode: ProviderMode;
  apiHost: string;
  configured: boolean;
  payoutsEnabled: boolean;
  webhook: {
    configured: boolean;
    port: number;
    lastVerifiedAt: IsoDateTime | null;
    recent: { seq: number; eventType: string | null; verification: 'verified' | 'failed' | 'duplicate'; failureCode: string | null; receivedAt: IsoDateTime }[];
  };
  allowlist: { receiverMasked: string; label: string; active: boolean; addedAt: IsoDateTime }[];
  limits: {
    currencies: readonly PayoutCurrency[];
    maxPerPayoutMinor: number;
    maxPayoutsPerDay: number;
    maxValuePerCurrencyPerDayMinor: number;
    proposalExpiryHours: number;
    maxRecoveryAttempts: number;
  };
  lastConnectionCheck: ConnectionCheckResult | null;
  canRunConnectionCheck: boolean;
}

export interface ConnectionCheckResult {
  ok: boolean;
  detail: string;
  checkedAt: IsoDateTime;
}

export interface AuditListItem extends AuditEntryView {
  entityType: string;
  entityId: string | null;
  requestId: string | null;
}

export interface AuditListResponse {
  entries: AuditListItem[];
  total: number;
  page: number;
  pageSize: number;
  actions: string[];
}

export interface DemoIdentitiesResponse {
  notice: string;
  currentUserId: string;
  identities: { id: string; displayName: string; role: Role }[];
}

export type JudgeScenarioOutcome = 'SUCCESS' | 'FAILED' | 'RETURNED' | 'UNCLAIMED';

export interface JudgeScenariosResponse {
  outcomes: JudgeScenarioOutcome[];
  created: number;
  max: number;
  /** How long a simulated recovery payout stays PENDING before the local stub reports the outcome. */
  settleSeconds: number;
}

export interface JudgeScenarioResponse {
  caseId: string;
  caseReference: string;
  outcome: JudgeScenarioOutcome;
}

/**
 * Where the approval figures come from, kept apart: cases in the synthetic history that reached "awaiting approval"
 * without a payment proposal, current proposals in the Approval centre, and payouts actually sent to the bound target.
 */
export interface ApprovalSources {
  historicalAwaitingCases: number;
  pendingProposals: number;
  submittedPayouts: number;
  paypalTarget: PayPalTarget | null;
}

export type OverviewResponse = Overview & { approvalSources: ApprovalSources };