import type {
  AuditEntryView,
  CancellationView,
  DiscrepancyView,
  LimitUsage,
  PaymentAttemptView,
  ProposalSummary,
  ReconciliationView,
  StatusCheckView,
  SubmissionView,
  UserRef,
} from '@shared/api/contracts';
import { DISCREPANCY_INFO, PAYOUT_LIMITS, type PayoutCurrency } from '@shared/domain/payouts';
import type { CurrencyCode } from '@shared/domain/money';
import type { AuditEventRow } from '../audit/auditLog';
import type { Db } from '../db/connection';
import { findUser, toProviderRecord, type BatchRow } from '../repositories/sqlite/readModel';
import type { Attempt } from './eligibility';
import { loadItem, loadSubmissionItem, startOfUtcDay, type CancellationRow, type DiscrepancyRow, type ProposalRow, type StatusCheckRow, type SubmissionRow } from './records';

export function userRef(db: Db, userId: string | null): UserRef | null {
  if (!userId) return null;
  const user = findUser(db, userId);
  return user ? { id: user.id, displayName: user.displayName } : { id: userId, displayName: 'Unknown user' };
}

export function auditEntryView(db: Db, row: AuditEventRow): AuditEntryView {
  const user = row.actor_user_id ? findUser(db, row.actor_user_id) : null;
  return {
    seq: row.seq,
    recordedAt: row.recorded_at,
    action: row.action,
    outcome: row.outcome,
    actor: row.actor_type === 'user' && row.actor_user_id ? { id: row.actor_user_id, displayName: user?.displayName ?? 'Unknown user', role: row.actor_role! } : null,
    previousState: row.previous_state ? JSON.parse(row.previous_state) : null,
    newState: row.new_state ? JSON.parse(row.new_state) : null,
    reason: row.reason,
  };
}

export function statusCheckView(db: Db, row: StatusCheckRow): StatusCheckView {
  return {
    id: row.id,
    source: row.source,
    outcome: row.outcome,
    itemStatus: row.item_status,
    errorName: row.error_name,
    httpStatus: row.http_status,
    debugId: row.debug_id,
    checkedAt: row.checked_at,
    requestedBy: userRef(db, row.requested_by_user_id),
  };
}

export function attemptView(db: Db, attempt: Attempt, kind: 'original' | 'recovery', attemptNumber: number | null): PaymentAttemptView {
  const batch = db.prepare('SELECT * FROM payment_batches WHERE id = ?').get(attempt.item.batch_id) as BatchRow;
  return {
    itemId: attempt.item.id,
    reference: attempt.item.payment_reference,
    kind,
    attemptNumber,
    amount: { currency: attempt.item.currency as CurrencyCode, minor: attempt.item.amount_minor },
    receiverMasked: attempt.item.receiver_masked,
    provider: attempt.provider ? toProviderRecord(attempt.provider) : null,
    batch: {
      id: batch.id,
      reference: batch.reference,
      providerMode: batch.provider_mode,
      providerBatchId: batch.provider_batch_id,
      status: batch.provider_status,
      submittedAt: batch.submitted_at,
    },
    latestCheck: attempt.latestCheck ? statusCheckView(db, attempt.latestCheck) : null,
    checkFresh: attempt.checkFresh,
  };
}

export function proposalSummary(db: Db, row: ProposalRow): ProposalSummary {
  const caseRef = db.prepare('SELECT reference FROM payment_cases WHERE id = ?').get(row.case_id) as { reference: string };
  const original = loadItem(db, row.original_item_id)!;
  return {
    id: row.id,
    caseId: row.case_id,
    caseReference: caseRef.reference,
    paymentReference: original.payment_reference,
    action: row.action,
    status: row.status,
    amount: { currency: row.currency as CurrencyCode, minor: row.amount_minor },
    receiverMasked: row.receiver_masked,
    attemptNumber: row.attempt_number,
    reasonCode: row.reason_code,
    proposedBy: userRef(db, row.proposed_by_user_id)!,
    proposedAt: row.proposed_at,
    expiresAt: row.expires_at,
    decidedBy: userRef(db, row.decided_by_user_id),
    decidedAt: row.decided_at,
    version: row.version,
  };
}

export function submissionView(db: Db, row: SubmissionRow): SubmissionView {
  const item = loadSubmissionItem(db, row.id);
  const recovery = item.recovery_item_id ? loadItem(db, item.recovery_item_id) : undefined;
  return {
    id: row.id,
    proposalId: row.proposal_id,
    state: row.state,
    senderBatchId: row.sender_batch_id,
    senderItemId: item.sender_item_id,
    approvedAt: row.approved_at,
    attemptCount: row.attempt_count,
    maxAttempts: PAYOUT_LIMITS.maxSubmissionAttempts,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    replayDeadlineAt: row.replay_deadline_at,
    providerBatchId: row.provider_batch_id,
    lastHttpStatus: row.last_http_status,
    lastErrorName: row.last_error_name,
    lastDebugId: row.last_debug_id,
    acceptedAt: row.accepted_at,
    completedAt: row.completed_at,
    recoveryItem: recovery ? { id: recovery.id, reference: recovery.payment_reference } : null,
  };
}

export function cancellationView(db: Db, row: CancellationRow): CancellationView {
  const target = loadItem(db, row.target_item_id)!;
  return {
    id: row.id,
    proposalId: row.proposal_id,
    state: row.state,
    targetItem: { id: target.id, reference: target.payment_reference },
    providerItemId: row.provider_item_id,
    approvedAt: row.approved_at,
    sendCount: row.send_count,
    maxSends: PAYOUT_LIMITS.maxCancellationSends,
    lastSentAt: row.last_sent_at,
    sendDeadlineAt: row.send_deadline_at,
    resolvedBy: row.resolved_by,
    lastHttpStatus: row.last_http_status,
    lastErrorName: row.last_error_name,
    completedAt: row.completed_at,
  };
}

export function discrepancyView(db: Db, row: DiscrepancyRow): DiscrepancyView {
  const item = row.payment_item_id ? loadItem(db, row.payment_item_id) : undefined;
  const resolution = db.prepare('SELECT * FROM provider_discrepancy_resolutions WHERE discrepancy_id = ?').get(row.id) as
    | { resolved_by_user_id: string; note: string; resolved_at: string }
    | undefined;
  return {
    id: row.id,
    code: row.code,
    severity: row.severity,
    description: DISCREPANCY_INFO[row.code],
    expected: row.expected,
    actual: row.actual,
    recordedAt: row.recorded_at,
    payment: item ? { id: item.id, reference: item.payment_reference } : null,
    resolution: resolution ? { by: userRef(db, resolution.resolved_by_user_id)!, note: resolution.note, resolvedAt: resolution.resolved_at } : null,
  };
}

export function reconciliationView(
  db: Db,
  row: { id: string; action: ReconciliationView['action']; submission_id: string | null; cancellation_id: string | null; provider_batch_id: string | null; note: string | null; user_id: string; recorded_at: string },
): ReconciliationView {
  return {
    id: row.id,
    action: row.action,
    submissionId: row.submission_id,
    cancellationId: row.cancellation_id,
    providerBatchId: row.provider_batch_id,
    note: row.note,
    by: userRef(db, row.user_id)!,
    recordedAt: row.recorded_at,
  };
}

/** Today's (UTC) approved Sandbox payouts for an organisation, counted from every submission whatever its state. */
export function limitUsage(db: Db, organisationId: string, currency: PayoutCurrency, now: Date): LimitUsage {
  const since = startOfUtcDay(now);
  const count = db.prepare('SELECT count(*) AS n FROM payout_submissions WHERE organisation_id = ? AND approved_at >= ?').get(organisationId, since) as { n: number };
  const value = db
    .prepare(
      `SELECT coalesce(sum(si.amount_minor), 0) AS total FROM payout_submissions s JOIN payout_submission_items si ON si.submission_id = s.id
       WHERE s.organisation_id = ? AND s.approved_at >= ? AND si.currency = ?`,
    )
    .get(organisationId, since, currency) as { total: number };
  return {
    currency,
    payoutsToday: count.n,
    maxPayoutsPerDay: PAYOUT_LIMITS.maxPayoutsPerDay,
    valueTodayMinor: value.total,
    maxValuePerCurrencyPerDayMinor: PAYOUT_LIMITS.maxValuePerCurrencyPerDayMinor,
    maxPerPayoutMinor: PAYOUT_LIMITS.maxPerPayoutMinor,
  };
}
