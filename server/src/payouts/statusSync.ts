import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { SANDBOX_RESULT_SUFFIX, type StatusCheckSource } from '@shared/domain/payouts';
import type { Db } from '../db/connection';
import { AppError } from '../lib/errors';
import type { PayPalClient } from '../paypal/client';
import { parseBatch, parseItem, type ParsedItem } from '../paypal/parse';
import { nextCaseReference } from '../services/caseReferences';
import {
  activeCaseFor,
  insertPaymentEvent,
  insertStatusCheck,
  loadCase,
  loadItem,
  loadProposal,
  loadProvider,
  originalOf,
  recordDiscrepancy,
  recoveriesOf,
  transitionCase,
  type FullItemRow,
  type ProposalRow,
  type StatusCheckRow,
  type SubmissionItemRow,
  type SubmissionRow,
} from './records';
import { auditPayout, targetText } from './target';

export interface PayoutDeps {
  db: Db;
  clock: () => Date;
  client: PayPalClient | null;
  logger: Logger;
}

export const SANDBOX_SUFFIX = SANDBOX_RESULT_SUFFIX;

/** The PayPal Sandbox item ID for a payment, if ReliefRelay knows one. */
export function providerItemIdFor(db: Db, paymentItemId: string): string | null {
  const provider = loadProvider(db, paymentItemId);
  if (provider?.mode === 'sandbox' && provider.provider_item_id) return provider.provider_item_id;
  const sub = db.prepare('SELECT provider_item_id FROM payout_submission_items WHERE recovery_item_id = ?').get(paymentItemId) as
    | { provider_item_id: string | null }
    | undefined;
  return sub?.provider_item_id ?? null;
}

function requireClient(deps: PayoutDeps): PayPalClient {
  if (!deps.client) throw new AppError('service_unavailable', 'PayPal Sandbox is not configured on this server.');
  return deps.client;
}

/**
 * Fetches one item's status from PayPal Sandbox, records the check and applies the result. This is the only way a
 * Sandbox status reaches ReliefRelay: webhook payloads are never trusted for status.
 */
export async function fetchItemStatus(
  deps: PayoutDeps,
  input: { paymentItemId: string; source: StatusCheckSource; requestedByUserId?: string | null; context?: 'cancellation' },
): Promise<StatusCheckRow> {
  const { db } = deps;
  const client = requireClient(deps);
  const item = loadItem(db, input.paymentItemId);
  if (!item) throw new AppError('not_found', 'Payment not found.');
  const providerItemId = providerItemIdFor(db, item.id);
  if (!providerItemId) throw new AppError('conflict', 'This payment has no PayPal Sandbox item to check yet.');

  const result = await client.getItem(providerItemId);
  const checkedAt = deps.clock().toISOString();
  const base = { organisationId: item.organisation_id, paymentItemId: item.id, providerItemId, source: input.source, requestedByUserId: input.requestedByUserId ?? null, checkedAt };

  return db
    .transaction(() => {
      if (!result.ok) {
        return insertStatusCheck(db, {
          ...base,
          outcome: result.status === 404 ? 'not_found' : 'error',
          itemStatus: null,
          errorName: result.name ?? (result.kind === 'network' ? 'NETWORK_ERROR' : null),
          httpStatus: result.status,
          debugId: result.debugId,
        });
      }
      const parsed = parseItem(result.body);
      if (!parsed || parsed.status === null || parsed.payoutItemId !== providerItemId) {
        const original = originalOf(db, item.id)!;
        if (parsed && parsed.status === null) {
          recordDiscrepancy(db, {
            organisationId: item.organisation_id,
            originalItemId: original.id,
            paymentItemId: item.id,
            code: 'unknown_status',
            severity: 'critical',
            expected: 'A documented payout item status',
            actual: parsed.rawStatus ?? 'missing',
            recordedAt: checkedAt,
          });
        }
        return insertStatusCheck(db, { ...base, outcome: 'unrecognised', itemStatus: null, errorName: parsed ? null : 'MALFORMED_RESPONSE', httpStatus: result.status, debugId: result.debugId });
      }
      const check = insertStatusCheck(db, {
        ...base,
        outcome: 'ok',
        itemStatus: parsed.status,
        providerBatchId: parsed.payoutBatchId,
        errorName: parsed.errorName,
        httpStatus: result.status,
        debugId: result.debugId,
      });
      applyItemStatus(deps, { item, parsed, check, context: input.context });
      return check;
    })
    .immediate();
}

/**
 * Applies a status fetched from PayPal Sandbox to a recovery payment. Stale results (older than the stored record)
 * are ignored. Call inside a transaction.
 */
export function applyItemStatus(deps: PayoutDeps, input: { item: FullItemRow; parsed: ParsedItem; check: StatusCheckRow; context?: 'cancellation' }): void {
  const { db } = deps;
  const { item, parsed, check } = input;
  const status = parsed.status!;
  const at = check.checked_at;
  const original = originalOf(db, item.id)!;
  const subItem = db.prepare('SELECT * FROM payout_submission_items WHERE recovery_item_id = ?').get(item.id) as SubmissionItemRow | undefined;

  const discrepancy = (code: Parameters<typeof recordDiscrepancy>[1]['code'], expected: string, actual: string) =>
    recordDiscrepancy(db, {
      organisationId: item.organisation_id,
      originalItemId: original.id,
      paymentItemId: item.id,
      submissionId: subItem?.submission_id ?? null,
      code,
      severity: 'critical',
      expected,
      actual,
      recordedAt: at,
    });
  if (parsed.rawAmount !== null || parsed.currency !== null) {
    if (parsed.amountMinor === null) discrepancy('malformed_amount', 'A two-decimal amount', parsed.rawAmount ?? 'missing');
    else if (parsed.amountMinor !== item.amount_minor) discrepancy('amount_mismatch', String(item.amount_minor), String(parsed.amountMinor));
    if (parsed.currency !== item.currency) discrepancy('currency_mismatch', item.currency, parsed.currency ?? 'missing');
  }
  if (parsed.currencyConversion) discrepancy('currency_conversion', 'No conversion', 'Conversion applied');
  if (subItem && parsed.senderItemId !== null && parsed.senderItemId !== subItem.sender_item_id) {
    discrepancy('sender_item_mismatch', subItem.sender_item_id, parsed.senderItemId);
  }
  if (subItem && !subItem.provider_item_id) {
    db.prepare('UPDATE payout_submission_items SET provider_item_id = ? WHERE id = ?').run(parsed.payoutItemId, subItem.id);
  }

  const existing = loadProvider(db, item.id);
  let previous: typeof status | null = null;
  if (!existing) {
    db.prepare(
      `INSERT INTO provider_transactions (payment_item_id, mode, provider_item_id, provider_transaction_id, status, error_code, amount_minor, currency, status_updated_at, updated_at)
       VALUES (?, 'sandbox', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(item.id, parsed.payoutItemId, parsed.transactionId, status, parsed.errorName, item.amount_minor, item.currency, at, at);
  } else {
    if (existing.mode !== 'sandbox') return;
    if (at < existing.updated_at) return;
    previous = existing.status;
    if (existing.status === status) {
      db.prepare('UPDATE provider_transactions SET updated_at = ?, provider_transaction_id = coalesce(provider_transaction_id, ?) WHERE payment_item_id = ?').run(
        at,
        parsed.transactionId,
        item.id,
      );
      return;
    }
    db.prepare(
      `UPDATE provider_transactions SET status = ?, error_code = ?, provider_item_id = coalesce(provider_item_id, ?),
         provider_transaction_id = coalesce(?, provider_transaction_id), status_updated_at = ?, updated_at = ? WHERE payment_item_id = ?`,
    ).run(status, parsed.errorName, parsed.payoutItemId, parsed.transactionId, at, at, item.id);
  }

  const caseRow = activeCaseFor(db, original.id);
  const cancelled = input.context === 'cancellation' && status === 'RETURNED';
  insertPaymentEvent(db, {
    organisationId: item.organisation_id,
    batchId: item.batch_id,
    paymentItemId: item.id,
    caseId: caseRow?.id ?? null,
    type: 'provider_status_changed',
    source: 'sandbox',
    occurredAt: at,
    previousStatus: previous,
    newStatus: status,
    summary: cancelled
      ? `PayPal Sandbox shows recovery payout ${item.payment_reference} as RETURNED after the approved cancellation. ${SANDBOX_SUFFIX}`
      : `PayPal Sandbox reports recovery payout ${item.payment_reference} as ${status}${previous ? ` (was ${previous})` : ''}. ${SANDBOX_SUFFIX}`,
  });
  applyCaseEffects(deps, { original, item, status, at, cancelled });
}

/** Case consequences of a changed Sandbox status. Never sends anything to PayPal. Call inside a transaction. */
function applyCaseEffects(
  deps: PayoutDeps,
  input: { original: FullItemRow; item: FullItemRow; status: NonNullable<ParsedItem['status']>; at: string; cancelled: boolean },
): void {
  const { db } = deps;
  const { original, item, status, at } = input;
  let caseRow = activeCaseFor(db, original.id);

  if (!caseRow) {
    if (status === 'REFUNDED' || status === 'REVERSED') openFollowUpCase(db, original, item, status, at);
    return;
  }

  const open = db.prepare("SELECT * FROM payout_proposals WHERE original_item_id = ? AND status = 'pending_approval'").get(original.id) as ProposalRow | undefined;
  if (open) {
    supersedeProposal(db, open, at, `PayPal Sandbox now reports ${item.payment_reference} as ${status}, so the proposal no longer matches the evidence it was based on.`);
    caseRow = loadCase(db, caseRow.id)!;
  }

  const recoveries = recoveriesOf(db, original.id);
  const latest = recoveries.at(-1);
  if (caseRow.state !== 'recovery_submitted' || latest?.id !== item.id) return;

  if (status === 'SUCCESS') {
    const approver = db
      .prepare(
        `SELECT p.decided_by_user_id AS user_id FROM payout_submission_items si
         JOIN payout_submissions s ON s.id = si.submission_id JOIN payout_proposals p ON p.id = s.proposal_id
         WHERE si.recovery_item_id = ?`,
      )
      .get(item.id) as { user_id: string } | undefined;
    if (!approver) return;
    transitionCase(db, {
      caseRow,
      to: 'resolved',
      at,
      actor: { type: 'system' },
      source: 'system',
      summary: `Recovered in PayPal Sandbox: recovery payout ${item.payment_reference} reports SUCCESS. ${SANDBOX_SUFFIX}`,
      auditAction: 'payout.case_resolved',
      resolution: {
        summary: `PayPal Sandbox reports recovery payout ${item.payment_reference} as SUCCESS. ${SANDBOX_SUFFIX}`,
        resolvedByUserId: approver.user_id,
        recoveryItemId: item.id,
      },
    });
  } else if (status === 'FAILED' || status === 'RETURNED' || status === 'BLOCKED') {
    transitionCase(db, {
      caseRow,
      to: 'investigating',
      at,
      actor: { type: 'system' },
      source: 'system',
      summary: input.cancelled
        ? `Cancellation confirmed: PayPal Sandbox shows ${item.payment_reference} as RETURNED. Any reissue needs a fresh status check and a new approval.`
        : `PayPal Sandbox reports recovery payout ${item.payment_reference} as ${status}. The case is back under investigation; nothing is resent automatically.`,
      auditAction: 'payout.case_reopened_for_investigation',
    });
  }
}

/** Marks a pending proposal as superseded and returns the case to the state it had before the proposal. */
export function supersedeProposal(db: Db, proposal: ProposalRow, at: string, reason: string): void {
  if (proposal.status !== 'pending_approval') return;
  db.prepare("UPDATE payout_proposals SET status = 'superseded', decided_at = ?, decision_reason = ?, version = version + 1 WHERE id = ?"  ).run(
    at,
    targetText(db, reason).slice(0, 500),
    proposal.id,
  );
  auditPayout(db, {
    organisationId: proposal.organisation_id,
    actor: { type: 'system' },
    action: 'payout.proposal_superseded',
    entityType: 'payout_proposal',
    entityId: proposal.id,
    outcome: 'succeeded',
    previousState: { status: 'pending_approval', version: proposal.version },
    newState: { status: 'superseded', version: proposal.version + 1 },
    reason: reason.slice(0, 500),
  });
  restoreCaseAfterProposal(db, loadProposal(db, proposal.id)!, at, { type: 'system' }, null, `Proposal ${proposal.action === 'reissue' ? 'to reissue' : 'to cancel'} superseded. ${reason}`);
}

/** Returns a case from awaiting_approval to the state it had when a proposal was made. */
export function restoreCaseAfterProposal(
  db: Db,
  proposal: ProposalRow,
  at: string,
  actor: Parameters<typeof transitionCase>[1]['actor'],
  requestId: string | null,
  summary: string,
): void {
  const caseRow = loadCase(db, proposal.case_id)!;
  if (caseRow.state !== 'awaiting_approval') return;
  transitionCase(db, {
    caseRow,
    to: proposal.previous_case_state,
    at,
    actor,
    requestId,
    source: actor.type === 'user' ? 'operator' : 'system',
    summary,
    auditAction: 'payout.case_restored',
  });
}

function openFollowUpCase(db: Db, original: FullItemRow, item: FullItemRow, status: string, at: string): void {
  const id = `case_${randomUUID()}`;
  const reference = nextCaseReference(db, original.organisation_id);
  const reason = targetText(db, `PayPal Sandbox reports recovery payout ${item.payment_reference} as ${status} after the case was resolved.`);
  db.prepare(
    `INSERT INTO payment_cases (id, organisation_id, reference, payment_item_id, state, basis, opening_reason, opened_at, updated_at, version)
     VALUES (?, ?, ?, ?, 'open', 'provider_confirmed', ?, ?, ?, 1)`,
  ).run(id, original.organisation_id, reference, original.id, reason, at, at);
  insertPaymentEvent(db, {
    organisationId: original.organisation_id,
    batchId: original.batch_id,
    paymentItemId: original.id,
    caseId: id,
    type: 'case_opened',
    source: 'system',
    occurredAt: at,
    newCaseState: 'open',
    summary: `Case ${reference} opened: ${reason}`,
  });
  auditPayout(db, {
    organisationId: original.organisation_id,
    actor: { type: 'system' },
    action: 'case.opened',
    entityType: 'payment_case',
    entityId: id,
    outcome: 'succeeded',
    newState: { state: 'open', reference },
    reason,
  });
}

/**
 * Re-reads a submitted batch only to record the provider's batch status, after its item has settled. The item is
 * left alone: its status comes from item reads. Nothing is stored unless the provider's response names this batch
 * with a documented status; anything else is left for the full batch sync to flag.
 */
export async function refreshSubmissionBatchStatus(deps: PayoutDeps, submission: SubmissionRow): Promise<void> {
  const client = requireClient(deps);
  if (!submission.provider_batch_id || !submission.recovery_batch_id) return;
  const result = await client.getBatch(submission.provider_batch_id);
  if (!result.ok) {
    deps.logger.warn({ submissionId: submission.id, status: result.status, name: result.name }, 'PayPal Sandbox batch status read failed');
    return;
  }
  const batch = parseBatch(result.body);
  if (!batch || batch.batchStatus === null || batch.payoutBatchId !== submission.provider_batch_id) return;
  if (batch.senderBatchId !== null && batch.senderBatchId !== submission.sender_batch_id) return;
  deps.db
    .prepare('UPDATE payment_batches SET provider_status = ? WHERE id = ? AND provider_status IS NOT ?')
    .run(batch.batchStatus, submission.recovery_batch_id, batch.batchStatus);
}

/**
 * Reads a submitted batch from PayPal Sandbox and applies its single item. Batch status and item status are stored
 * separately: a SUCCESS batch says nothing about whether the item was delivered.
 */
export async function syncSubmissionBatch(deps: PayoutDeps, submission: SubmissionRow, source: StatusCheckSource): Promise<void> {
  const { db } = deps;
  const client = requireClient(deps);
  if (!submission.provider_batch_id || !submission.recovery_batch_id) return;
  const result = await client.getBatch(submission.provider_batch_id);
  const at = deps.clock().toISOString();
  if (!result.ok) {
    deps.logger.warn({ submissionId: submission.id, status: result.status, name: result.name }, 'PayPal Sandbox batch read failed');
    return;
  }
  const batch = parseBatch(result.body);
  if (!batch) {
    deps.logger.warn({ submissionId: submission.id }, 'PayPal Sandbox batch response was not recognised');
    return;
  }
  db.transaction(() => {
    const subItem = db.prepare('SELECT * FROM payout_submission_items WHERE submission_id = ?').get(submission.id) as SubmissionItemRow;
    const original = loadItem(db, subItem.original_item_id)!;
    const originalRoot = originalOf(db, original.id)!;
    const flag = (code: 'sender_batch_mismatch' | 'unexpected_batch_items' | 'unknown_status', expected: string, actual: string) =>
      recordDiscrepancy(db, {
        organisationId: submission.organisation_id,
        originalItemId: originalRoot.id,
        paymentItemId: subItem.recovery_item_id,
        submissionId: submission.id,
        code,
        severity: 'critical',
        expected,
        actual,
        recordedAt: at,
      });
    if (batch.senderBatchId !== null && batch.senderBatchId !== submission.sender_batch_id) flag('sender_batch_mismatch', submission.sender_batch_id, batch.senderBatchId);
    if (batch.batchStatus === null) flag('unknown_status', 'A documented batch status', batch.rawBatchStatus);
    else db.prepare('UPDATE payment_batches SET provider_status = ? WHERE id = ? AND provider_status IS NOT ?').run(batch.batchStatus, submission.recovery_batch_id, batch.batchStatus);

    const ours = batch.items.filter((i) => i.senderItemId === subItem.sender_item_id);
    const others = batch.items.filter((i) => i.senderItemId !== subItem.sender_item_id);
    if (others.length > 0) flag('unexpected_batch_items', '1 item', `${batch.items.length} items`);
    const parsed = ours[0];
    if (!parsed || !subItem.recovery_item_id) return;
    const recovery = loadItem(db, subItem.recovery_item_id)!;
    if (parsed.status === null) {
      recordDiscrepancy(db, {
        organisationId: submission.organisation_id,
        originalItemId: originalRoot.id,
        paymentItemId: recovery.id,
        submissionId: submission.id,
        code: 'unknown_status',
        severity: 'critical',
        expected: 'A documented payout item status',
        actual: parsed.rawStatus ?? 'missing',
        recordedAt: at,
      });
      return;
    }
    const check = insertStatusCheck(db, {
      organisationId: submission.organisation_id,
      paymentItemId: recovery.id,
      providerItemId: parsed.payoutItemId,
      source,
      outcome: 'ok',
      itemStatus: parsed.status,
      providerBatchId: batch.payoutBatchId,
      errorName: parsed.errorName,
      httpStatus: result.status,
      debugId: result.debugId,
      checkedAt: at,
    });
    applyItemStatus(deps, { item: recovery, parsed, check });
  }).immediate();
}
