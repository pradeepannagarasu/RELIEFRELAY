import { randomUUID } from 'node:crypto';
import type { PayoutItemStatus } from '@shared/domain/paypal';
import type { CancellationState, DiscrepancyCode, ProposalAction, ProposalReasonCode, ProposalStatus, StatusCheckSource, SubmissionState } from '@shared/domain/payouts';
import type { CaseState } from '@shared/domain/types';
import { forPayPalTarget } from '@shared/domain/payouts';
import type { AuditActor } from '../audit/auditLog';
import { auditPayout, boundPayPalTarget, targetRecordFields, targetText } from './target';
import type { Db } from '../db/connection';
import type { CaseRow, ItemRow, ProviderRow } from '../repositories/sqlite/readModel';

/* Row types for the Phase 4 tables. */

export interface ProposalRow {
  id: string;
  organisation_id: string;
  case_id: string;
  original_item_id: string;
  action: ProposalAction;
  target_item_id: string;
  attempt_number: number | null;
  amount_minor: number;
  currency: string;
  receiver_masked: string;
  allowlist_entry_id: string | null;
  reason_code: ProposalReasonCode;
  justification: string;
  attestation: number;
  provider_fingerprint: string;
  status_check_id: string | null;
  previous_case_state: CaseState;
  case_version: number;
  proposed_by_user_id: string;
  proposed_at: string;
  expires_at: string;
  status: ProposalStatus;
  version: number;
  decided_by_user_id: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  confirmation_sha256: string | null;
}

export interface SubmissionRow {
  id: string;
  organisation_id: string;
  case_id: string;
  proposal_id: string;
  sender_batch_id: string;
  paypal_request_id: string;
  request_sha256: string;
  approved_at: string;
  replay_deadline_at: string;
  state: SubmissionState;
  attempt_count: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  lease_until: string | null;
  recovery_batch_id: string | null;
  provider_batch_id: string | null;
  last_http_status: number | null;
  last_error_name: string | null;
  last_debug_id: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  version: number;
}

export interface SubmissionItemRow {
  id: string;
  submission_id: string;
  original_item_id: string;
  sender_item_id: string;
  amount_minor: number;
  currency: string;
  recovery_item_id: string | null;
  provider_item_id: string | null;
}

export interface CancellationRow {
  id: string;
  organisation_id: string;
  case_id: string;
  proposal_id: string;
  target_item_id: string;
  provider_item_id: string;
  approved_at: string;
  send_deadline_at: string;
  state: CancellationState;
  send_count: number;
  last_sent_at: string | null;
  sent_with_check_id: string | null;
  precheck_status_check_id: string | null;
  last_status_check_id: string | null;
  resolved_by: 'cancel_response' | 'status_check' | null;
  lease_until: string | null;
  next_attempt_at: string | null;
  last_http_status: number | null;
  last_error_name: string | null;
  last_debug_id: string | null;
  completed_at: string | null;
  version: number;
}

export interface StatusCheckRow {
  id: string;
  organisation_id: string;
  payment_item_id: string;
  provider_item_id: string;
  source: StatusCheckSource;
  outcome: 'ok' | 'not_found' | 'error' | 'unrecognised';
  item_status: PayoutItemStatus | null;
  provider_batch_id: string | null;
  error_name: string | null;
  http_status: number | null;
  debug_id: string | null;
  requested_by_user_id: string | null;
  checked_at: string;
}

export interface DiscrepancyRow {
  id: string;
  organisation_id: string;
  original_item_id: string;
  payment_item_id: string | null;
  submission_id: string | null;
  code: DiscrepancyCode;
  severity: 'warning' | 'critical';
  expected: string | null;
  actual: string | null;
  recorded_at: string;
}

export interface FullItemRow extends ItemRow {
  receiver_value: string;
}

export const ACTIVE_SUBMISSION_STATES: SubmissionState[] = ['prepared', 'sending', 'not_processed', 'outcome_unknown'];
export const ACTIVE_CANCELLATION_STATES: CancellationState[] = ['prepared', 'prechecking', 'sending', 'not_processed', 'outcome_unknown'];
const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
export const ACTIVE_SUBMISSION_SQL = sqlList(ACTIVE_SUBMISSION_STATES);
export const ACTIVE_CANCELLATION_SQL = sqlList(ACTIVE_CANCELLATION_STATES);

export const addMs = (iso: string | Date, ms: number) => new Date((typeof iso === 'string' ? Date.parse(iso) : iso.getTime()) + ms).toISOString();
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function startOfUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/* Loaders */

export const loadItem = (db: Db, itemId: string) => db.prepare('SELECT * FROM payment_items WHERE id = ?').get(itemId) as FullItemRow | undefined;
export const loadProvider = (db: Db, itemId: string) =>
  db.prepare('SELECT * FROM provider_transactions WHERE payment_item_id = ?').get(itemId) as (ProviderRow & { updated_at: string }) | undefined;
export const loadCase = (db: Db, caseId: string) => db.prepare('SELECT * FROM payment_cases WHERE id = ?').get(caseId) as CaseRow | undefined;
export const loadProposal = (db: Db, id: string) => db.prepare('SELECT * FROM payout_proposals WHERE id = ?').get(id) as ProposalRow | undefined;
export const loadSubmission = (db: Db, id: string) => db.prepare('SELECT * FROM payout_submissions WHERE id = ?').get(id) as SubmissionRow | undefined;
export const loadSubmissionItem = (db: Db, submissionId: string) =>
  db.prepare('SELECT * FROM payout_submission_items WHERE submission_id = ?').get(submissionId) as SubmissionItemRow;
export const loadCancellation = (db: Db, id: string) => db.prepare('SELECT * FROM payout_cancellations WHERE id = ?').get(id) as CancellationRow | undefined;
export const loadCheck = (db: Db, id: string) => db.prepare('SELECT * FROM provider_status_checks WHERE id = ?').get(id) as StatusCheckRow | undefined;

/** The case for a payment that is still active, if any. */
export const activeCaseFor = (db: Db, itemId: string) =>
  db.prepare("SELECT * FROM payment_cases WHERE payment_item_id = ? AND state NOT IN ('resolved', 'closed')").get(itemId) as CaseRow | undefined;

/** The original payment a recovery belongs to (following recovery_of_item_id back to the first payment). */
export function originalOf(db: Db, itemId: string): FullItemRow | undefined {
  let item = loadItem(db, itemId);
  for (let depth = 0; item?.recovery_of_item_id && depth < 10; depth += 1) item = loadItem(db, item.recovery_of_item_id);
  return item;
}

/** Recoveries of an original payment, oldest first. */
export function recoveriesOf(db: Db, originalItemId: string): FullItemRow[] {
  const result: FullItemRow[] = [];
  let frontier = [originalItemId];
  for (let depth = 0; frontier.length && depth < 10; depth += 1) {
    const next = db
      .prepare(`SELECT * FROM payment_items WHERE recovery_of_item_id IN (${frontier.map(() => '?').join(',')}) ORDER BY created_at, rowid`)
      .all(...frontier) as FullItemRow[];
    result.push(...next);
    frontier = next.map((i) => i.id);
  }
  return result.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

export function latestCheck(db: Db, itemId: string): StatusCheckRow | undefined {
  return db.prepare('SELECT * FROM provider_status_checks WHERE payment_item_id = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1').get(itemId) as
    | StatusCheckRow
    | undefined;
}

/* Writers */

export interface PaymentEventInput {
  organisationId: string;
  batchId: string;
  paymentItemId: string | null;
  caseId: string | null;
  type: 'batch_submitted' | 'provider_status_changed' | 'case_opened' | 'case_state_changed' | 'recovery_submitted';
  source: 'sandbox' | 'simulation' | 'operator' | 'system';
  occurredAt: string;
  providerEventType?: string | null;
  previousStatus?: PayoutItemStatus | null;
  newStatus?: PayoutItemStatus | null;
  previousCaseState?: CaseState | null;
  newCaseState?: CaseState | null;
  actorUserId?: string | null;
  summary: string;
}

export function insertPaymentEvent(db: Db, e: PaymentEventInput): string {
  const id = `evt_${randomUUID()}`;
  const target = boundPayPalTarget(db);
  const source = e.source === 'sandbox' ? targetRecordFields(target).eventSource : e.source;
  db.prepare(
    `INSERT INTO payment_events (id, organisation_id, batch_id, payment_item_id, case_id, type, source, occurred_at, recorded_at,
       provider_event_type, previous_status, new_status, previous_case_state, new_case_state, actor_user_id, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    e.organisationId,
    e.batchId,
    e.paymentItemId,
    e.caseId,
    e.type,
    source,
    e.occurredAt,
    e.occurredAt,
    e.providerEventType ?? null,
    e.previousStatus ?? null,
    e.newStatus ?? null,
    e.previousCaseState ?? null,
    e.newCaseState ?? null,
    e.actorUserId ?? null,
    forPayPalTarget(e.summary, target).slice(0, 500),
  );
  return id;
}

export interface CaseTransition {
  caseRow: CaseRow;
  to: CaseState;
  at: string;
  actor: AuditActor;
  requestId?: string | null;
  eventType?: 'case_state_changed' | 'recovery_submitted';
  source: 'operator' | 'system';
  summary: string;
  auditAction: string;
  resolution?: { summary: string; resolvedByUserId: string; recoveryItemId: string };
}

/** Moves a case to a new state with its timeline event and audit entry. Call inside a transaction. */
export function transitionCase(db: Db, t: CaseTransition): CaseRow {
  const { caseRow } = t;
  if (t.resolution) {
    db.prepare(
      `UPDATE payment_cases SET state = 'resolved', resolution_kind = 'recovered', resolution_summary = ?, resolved_at = ?,
         resolved_by_user_id = ?, recovery_item_id = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(targetText(db, t.resolution.summary).slice(0, 500), t.at, t.resolution.resolvedByUserId, t.resolution.recoveryItemId, t.at, caseRow.id);
  } else {
    db.prepare('UPDATE payment_cases SET state = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(t.to, t.at, caseRow.id);
  }
  const item = loadItem(db, caseRow.payment_item_id)!;
  insertPaymentEvent(db, {
    organisationId: caseRow.organisation_id,
    batchId: item.batch_id,
    paymentItemId: caseRow.payment_item_id,
    caseId: caseRow.id,
    type: t.eventType ?? 'case_state_changed',
    source: t.source,
    occurredAt: t.at,
    previousCaseState: caseRow.state,
    newCaseState: t.to,
    actorUserId: t.actor.type === 'user' ? t.actor.userId : null,
    summary: t.summary,
  });
  auditPayout(db, {
    organisationId: caseRow.organisation_id,
    actor: t.actor,
    action: t.auditAction,
    entityType: 'payment_case',
    entityId: caseRow.id,
    outcome: 'succeeded',
    requestId: t.requestId ?? null,
    previousState: { state: caseRow.state, version: caseRow.version },
    newState: { state: t.to, version: caseRow.version + 1, ...(t.resolution ? { resolution: 'recovered', recoveryItemId: t.resolution.recoveryItemId } : {}) },
    reason: t.summary.slice(0, 500),
  });
  return loadCase(db, caseRow.id)!;
}

export interface StatusCheckInput {
  organisationId: string;
  paymentItemId: string;
  providerItemId: string;
  source: StatusCheckSource;
  outcome: StatusCheckRow['outcome'];
  itemStatus: PayoutItemStatus | null;
  providerBatchId?: string | null;
  errorName?: string | null;
  httpStatus?: number | null;
  debugId?: string | null;
  requestedByUserId?: string | null;
  checkedAt: string;
}

export function insertStatusCheck(db: Db, c: StatusCheckInput): StatusCheckRow {
  const id = `chk_${randomUUID()}`;
  db.prepare(
    `INSERT INTO provider_status_checks (id, organisation_id, payment_item_id, provider_item_id, source, outcome, item_status,
       provider_batch_id, error_name, http_status, debug_id, requested_by_user_id, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    c.organisationId,
    c.paymentItemId,
    c.providerItemId,
    c.source,
    c.outcome,
    c.outcome === 'ok' ? c.itemStatus : null,
    c.providerBatchId ?? null,
    c.errorName?.slice(0, 100) ?? null,
    c.httpStatus ?? null,
    c.debugId?.slice(0, 64) ?? null,
    c.requestedByUserId ?? null,
    c.checkedAt,
  );
  return loadCheck(db, id)!;
}

export interface DiscrepancyInput {
  organisationId: string;
  originalItemId: string;
  paymentItemId?: string | null;
  submissionId?: string | null;
  code: DiscrepancyCode;
  severity: 'warning' | 'critical';
  expected?: string | null;
  actual?: string | null;
  recordedAt: string;
}

/** Records a discrepancy unless an unresolved one with the same code already exists for the same payment. */
export function recordDiscrepancy(db: Db, d: DiscrepancyInput): boolean {
  const existing = db
    .prepare(
      `SELECT 1 FROM provider_discrepancies p
       WHERE p.original_item_id = ? AND p.code = ? AND p.payment_item_id IS ?
         AND NOT EXISTS (SELECT 1 FROM provider_discrepancy_resolutions r WHERE r.discrepancy_id = p.id)`,
    )
    .get(d.originalItemId, d.code, d.paymentItemId ?? null);
  if (existing) return false;
  const id = `dis_${randomUUID()}`;
  db.prepare(
    `INSERT INTO provider_discrepancies (id, organisation_id, original_item_id, payment_item_id, submission_id, code, severity, expected, actual, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    d.organisationId,
    d.originalItemId,
    d.paymentItemId ?? null,
    d.submissionId ?? null,
    d.code,
    d.severity,
    d.expected?.slice(0, 200) ?? null,
    d.actual?.slice(0, 200) ?? null,
    d.recordedAt,
  );
  auditPayout(db, {
    organisationId: d.organisationId,
    actor: { type: 'system' },
    action: 'paypal.discrepancy_recorded',
    entityType: 'provider_discrepancy',
    entityId: id,
    outcome: 'succeeded',
    newState: { code: d.code, severity: d.severity, paymentItemId: d.paymentItemId ?? null },
    reason: `PayPal Sandbox data did not match what ReliefRelay sent (${d.code}).`,
  });
  return true;
}

export function hasUnresolvedCriticalDiscrepancy(db: Db, originalItemId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM provider_discrepancies p
       WHERE p.original_item_id = ? AND p.severity = 'critical'
         AND NOT EXISTS (SELECT 1 FROM provider_discrepancy_resolutions r WHERE r.discrepancy_id = p.id)`,
    )
    .get(originalItemId);
}
