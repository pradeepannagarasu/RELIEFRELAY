import { randomUUID } from 'node:crypto';
import { PAYOUT_BATCH_STATUSES, type PayoutBatchStatus } from '@shared/domain/paypal';
import { isPayoutCurrency, PAYOUT_LIMITS, type PayoutCurrency } from '@shared/domain/payouts';
import type { AuditActor } from '../audit/auditLog';
import { paymentFingerprint } from '../lib/paymentIdentity';
import { parseBatch, batchIdFromLinks } from '../paypal/parse';
import { buildPayoutRequest } from '../paypal/requestBuilder';
import { findActiveEntry } from './allowlist';
import {
  addMs,
  DAY,
  HOUR,
  insertPaymentEvent,
  loadCase,
  loadItem,
  loadProposal,
  loadSubmission,
  loadSubmissionItem,
  MINUTE,
  recordDiscrepancy,
  transitionCase,
  type SubmissionRow,
} from './records';
import { SANDBOX_SUFFIX, syncSubmissionBatch, type PayoutDeps } from './statusSync';
import { auditPayout, boundPayPalTarget, targetRecordFields } from './target';

export interface SubmissionDeps extends PayoutDeps {
  payoutsEnabled: () => boolean;
  /** Waits between the immediate replays made during approval. Injected so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** Immediate replays made inside the approval request when the first answer is unclear. */
const IMMEDIATE_REPLAY_DELAYS_MS = [1_000, 5_000];
const IN_REQUEST_ATTEMPTS = IMMEDIATE_REPLAY_DELAYS_MS.length + 1;

/** Scheduled replays after the in-request attempts: +5 min, +15 min, +1 h, +6 h, +24 h, then daily. */
const REPLAY_SCHEDULE_MS = [5 * MINUTE, 15 * MINUTE, HOUR, 6 * HOUR, DAY];
export const replayDelay = (attemptCount: number) => REPLAY_SCHEDULE_MS[Math.min(Math.max(attemptCount - IN_REQUEST_ATTEMPTS, 0), REPLAY_SCHEDULE_MS.length - 1)]!;
const IMMEDIATE_BUDGET_MS = 20_000;
const LEASE_MS = 60_000;

const REPLAYABLE = new Set(['prepared', 'outcome_unknown', 'not_processed']);

type Outcome = 'accepted' | 'rejected' | 'not_processed' | 'outcome_unknown' | 'blocked_by_policy' | 'needs_manual_reconciliation' | 'skipped';

export function createSubmissionService(deps: SubmissionDeps) {
  const { db, clock, logger } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const system: AuditActor = { type: 'system' };

  const audit = (sub: SubmissionRow, action: string, outcome: 'succeeded' | 'rejected', reason: string, newState?: unknown) =>
    auditPayout(db, {
      organisationId: sub.organisation_id,
      actor: system,
      action,
      entityType: 'payout_submission',
      entityId: sub.id,
      outcome,
      newState,
      reason: reason.slice(0, 500),
    });

  const update = (sub: SubmissionRow, fields: Partial<SubmissionRow>) => {
    const entries = Object.entries(fields);
    db.prepare(`UPDATE payout_submissions SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, version = version + 1 WHERE id = ? AND version = ?`).run(
      ...entries.map(([, v]) => v as string | number | null),
      sub.id,
      sub.version,
    );
    const next = loadSubmission(db, sub.id)!;
    if (next.version !== sub.version + 1) throw new Error('Submission changed concurrently.');
    return next;
  };

  /** Moves a submission whose outcome cannot be settled automatically into manual reconciliation. */
  const requireManualReconciliation = (sub: SubmissionRow, reason: string, extra: Partial<SubmissionRow> = {}) => {
    const next = update(sub, { ...extra, state: 'needs_manual_reconciliation', lease_until: null, next_attempt_at: null });
    audit(next, 'payout.submission_needs_reconciliation', 'succeeded', reason, { state: next.state, attemptCount: next.attempt_count });
    return next;
  };

  const caseToInvestigating = (sub: SubmissionRow, at: string, summary: string) => {
    const caseRow = loadCase(db, sub.case_id)!;
    if (caseRow.state !== 'recovery_submitted') return;
    transitionCase(db, { caseRow, to: 'investigating', at, actor: system, source: 'system', summary, auditAction: 'payout.case_reopened_for_investigation' });
  };

  /** Records PayPal Sandbox's acceptance: creates the recovery batch and item and marks the submission accepted. */
  const recordAccepted = (sub: SubmissionRow, providerBatchId: string, batchStatus: string | null, httpStatus: number | null, actor: AuditActor) => {
    const at = clock().toISOString();
    const proposal = loadProposal(db, sub.proposal_id)!;
    const subItem = loadSubmissionItem(db, sub.id);
    const original = loadItem(db, subItem.original_item_id)!;
    const batchId = `bat_${randomUUID()}`;
    const status = (PAYOUT_BATCH_STATUSES as readonly string[]).includes(batchStatus ?? '') ? (batchStatus as PayoutBatchStatus) : null;
    const fields = targetRecordFields(boundPayPalTarget(db));
    db.prepare(
      `INSERT INTO payment_batches (id, organisation_id, reference, kind, origin, programme, sender_batch_id, provider_mode, provider_batch_id,
         provider_status, submitted_at, created_by_user_id, created_at)
       VALUES (?, ?, ?, 'recovery', 'provider_submission', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      batchId,
      sub.organisation_id,
      sub.sender_batch_id,
      fields.recoveryProgramme,
      sub.sender_batch_id,
      fields.batchProviderMode,
      providerBatchId,
      status,
      at,
      proposal.decided_by_user_id,
      at,
    );
    const itemId = `itm_${randomUUID()}`;
    db.prepare(
      `INSERT INTO payment_items (id, organisation_id, batch_id, payment_reference, recipient_reference, receiver_type, receiver_value, receiver_masked,
         amount_minor, currency, fingerprint, recovery_of_item_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      itemId,
      sub.organisation_id,
      batchId,
      subItem.sender_item_id,
      original.recipient_reference,
      original.receiver_type,
      original.receiver_value,
      original.receiver_masked,
      subItem.amount_minor,
      subItem.currency,
      paymentFingerprint({
        batchReference: sub.sender_batch_id,
        paymentReference: subItem.sender_item_id,
        recipientReference: original.recipient_reference,
        receiverType: original.receiver_type,
        receiver: original.receiver_value,
        amountMinor: subItem.amount_minor,
        currency: original.currency,
      }),
      original.id,
      at,
    );
    db.prepare('UPDATE payout_submission_items SET recovery_item_id = ? WHERE id = ?').run(itemId, subItem.id);
    const next = update(sub, {
      state: 'accepted',
      provider_batch_id: providerBatchId,
      recovery_batch_id: batchId,
      accepted_at: at,
      completed_at: at,
      lease_until: null,
      next_attempt_at: null,
      last_http_status: httpStatus,
    });
    insertPaymentEvent(db, {
      organisationId: sub.organisation_id,
      batchId,
      paymentItemId: itemId,
      caseId: sub.case_id,
      type: 'batch_submitted',
      source: 'sandbox',
      occurredAt: at,
      actorUserId: proposal.decided_by_user_id,
      summary: `Recovery payout ${subItem.sender_item_id} accepted by PayPal Sandbox in batch ${providerBatchId}. Item status is tracked separately. ${SANDBOX_SUFFIX}`,
    });
    auditPayout(db, {
      organisationId: sub.organisation_id,
      actor,
      action: 'payout.submission_accepted',
      entityType: 'payout_submission',
      entityId: sub.id,
      outcome: 'succeeded',
      newState: { state: 'accepted', providerBatchId, recoveryItemId: itemId, attemptCount: next.attempt_count },
      reason: 'PayPal Sandbox accepted the payout batch.',
    });
    return next;
  };

  /** Checks immediately before sending. Returns a reason to stop, or null. Call inside a transaction. */
  const policyStop = (sub: SubmissionRow): { reason: string; hashMismatch?: boolean; pause?: boolean } | null => {
    const proposal = loadProposal(db, sub.proposal_id)!;
    const subItem = loadSubmissionItem(db, sub.id);
    const original = loadItem(db, subItem.original_item_id)!;
    if (!deps.client) return { reason: 'PayPal Sandbox is not configured on this server.', pause: true };
    if (!deps.payoutsEnabled()) return { reason: 'Payment actions are switched off on this server.', pause: true };
    const entry = findActiveEntry(db, sub.organisation_id, original.receiver_type, original.receiver_value);
    if (!entry || entry.id !== proposal.allowlist_entry_id) return { reason: 'The receiver is no longer an active entry on the Sandbox receiver allowlist.' };
    if (!isPayoutCurrency(subItem.currency) || subItem.amount_minor > PAYOUT_LIMITS.maxPerPayoutMinor) return { reason: 'The amount or currency is outside the approved limits.' };
    const built = buildPayoutRequest({
      senderBatchId: sub.sender_batch_id,
      senderItemId: subItem.sender_item_id,
      receiver: original.receiver_value,
      amountMinor: subItem.amount_minor,
      currency: subItem.currency as PayoutCurrency,
    });
    if (built.sha256 !== sub.request_sha256) return { reason: 'The rebuilt request does not match the approved request.', hashMismatch: true };
    return null;
  };

  /** One send of the approved request, with the same keys and body as every other send of this submission. */
  async function attemptOnce(submissionId: string, trigger: string): Promise<{ outcome: Outcome; submission: SubmissionRow }> {
    const claim = db
      .transaction((): { send: false; outcome: Outcome } | { send: true; json: string; requestId: string; sub: SubmissionRow } => {
        const sub = loadSubmission(db, submissionId)!;
        const nowDate = clock();
        const now = nowDate.toISOString();
        if (!REPLAYABLE.has(sub.state)) return { send: false, outcome: 'skipped' };
        if (sub.lease_until && sub.lease_until > now) return { send: false, outcome: 'skipped' };
        if (now >= sub.replay_deadline_at || sub.attempt_count >= PAYOUT_LIMITS.maxSubmissionAttempts) {
          requireManualReconciliation(sub, 'The replay limit was reached without a definite answer from PayPal Sandbox. An administrator must reconcile this submission.');
          return { send: false, outcome: 'needs_manual_reconciliation' };
        }
        const stop = policyStop(sub);
        if (stop) {
          if (stop.pause && sub.attempt_count > 0) {
            update(sub, { next_attempt_at: addMs(nowDate, HOUR) });
            audit(sub, 'payout.submission_replay_paused', 'rejected', stop.reason);
            return { send: false, outcome: 'skipped' };
          }
          if (stop.hashMismatch) {
            const subItem = loadSubmissionItem(db, sub.id);
            recordDiscrepancy(db, {
              organisationId: sub.organisation_id,
              originalItemId: subItem.original_item_id,
              submissionId: sub.id,
              code: 'request_hash_mismatch',
              severity: 'critical',
              expected: sub.request_sha256,
              actual: 'different',
              recordedAt: now,
            });
          }
          if (sub.attempt_count === 0) {
            const next = update(sub, { state: 'blocked_by_policy', completed_at: now, next_attempt_at: null, lease_until: null });
            audit(next, 'payout.submission_blocked', 'rejected', `${stop.reason} Nothing was sent.`);
            caseToInvestigating(next, now, `Recovery payout not sent: ${stop.reason}`);
            return { send: false, outcome: 'blocked_by_policy' };
          }
          requireManualReconciliation(sub, `${stop.reason} An earlier attempt may have reached PayPal Sandbox, so the submission needs manual reconciliation.`);
          return { send: false, outcome: 'needs_manual_reconciliation' };
        }
        const subItem = loadSubmissionItem(db, sub.id);
        const original = loadItem(db, subItem.original_item_id)!;
        const built = buildPayoutRequest({
          senderBatchId: sub.sender_batch_id,
          senderItemId: subItem.sender_item_id,
          receiver: original.receiver_value,
          amountMinor: subItem.amount_minor,
          currency: subItem.currency as PayoutCurrency,
        });
        const next = update(sub, { state: 'sending', attempt_count: sub.attempt_count + 1, last_attempt_at: now, lease_until: addMs(nowDate, LEASE_MS), next_attempt_at: null });
        audit(next, 'payout.submission_sent', 'succeeded', `Attempt ${next.attempt_count} sent to PayPal Sandbox (${trigger}) with the approved keys.`, {
          attempt: next.attempt_count,
          senderBatchId: sub.sender_batch_id,
        });
        return { send: true, json: built.json, requestId: sub.paypal_request_id, sub: next };
      })
      .immediate();

    if (!claim.send) return { outcome: claim.outcome, submission: loadSubmission(db, submissionId)! };

    const result = await deps.client!.createPayout(claim.json, claim.requestId);
    let linkedBatch: string | null = null;

    const outcome = db
      .transaction((): Outcome => {
        const sub = loadSubmission(db, submissionId)!;
        if (sub.state !== 'sending') return 'skipped';
        const nowDate = clock();
        const now = nowDate.toISOString();
        const base = { lease_until: null, last_http_status: result.status, last_debug_id: result.debugId };

        if (result.ok) {
          const batch = parseBatch(result.body);
          if (batch && (batch.senderBatchId === null || batch.senderBatchId === sub.sender_batch_id)) {
            recordAccepted(sub, batch.payoutBatchId, batch.rawBatchStatus, result.status, system);
            return 'accepted';
          }
          if (batch) {
            const subItem = loadSubmissionItem(db, sub.id);
            recordDiscrepancy(db, {
              organisationId: sub.organisation_id,
              originalItemId: subItem.original_item_id,
              submissionId: sub.id,
              code: 'sender_batch_mismatch',
              severity: 'critical',
              expected: sub.sender_batch_id,
              actual: batch.senderBatchId,
              recordedAt: now,
            });
            requireManualReconciliation(sub, 'PayPal Sandbox answered with a batch carrying a different sender batch ID.', base);
            return 'needs_manual_reconciliation';
          }
          return scheduleReplay(sub, { ...base, last_error_name: 'MALFORMED_RESPONSE' }, nowDate, 'outcome_unknown');
        }

        const name = result.name;
        if (result.kind === 'network') return scheduleReplay(sub, { ...base, last_error_name: 'NETWORK_ERROR' }, nowDate, 'outcome_unknown');
        const status = result.status ?? 0;
        if (status === 429 || status === 401) return scheduleReplay(sub, { ...base, last_error_name: name }, nowDate, 'not_processed');
        if (status >= 500 || name === 'PREVIOUS_REQUEST_IN_PROGRESS' || status === 409) {
          return scheduleReplay(sub, { ...base, last_error_name: name }, nowDate, 'outcome_unknown');
        }
        const link = batchIdFromLinks(result.links);
        if (link) {
          linkedBatch = link;
          return scheduleReplay(sub, { ...base, last_error_name: name }, nowDate, 'outcome_unknown');
        }
        if (sub.attempt_count > 1) {
          requireManualReconciliation(
            sub,
            `PayPal Sandbox refused replay attempt ${sub.attempt_count} (${name ?? `HTTP ${status}`}), but an earlier attempt may have created the payout. An administrator must reconcile this submission.`,
            { ...base, last_error_name: name },
          );
          return 'needs_manual_reconciliation';
        }
        const next = update(sub, { ...base, state: 'rejected', last_error_name: name, completed_at: now, next_attempt_at: null });
        audit(next, 'payout.submission_rejected', 'succeeded', `PayPal Sandbox refused the request (${name ?? `HTTP ${status}`}). No payout was created.`);
        caseToInvestigating(next, now, `PayPal Sandbox refused the recovery payout request (${name ?? `HTTP ${status}`}). No payout was created; nothing is resent automatically.`);
        return 'rejected';
      })
      .immediate();

    if (linkedBatch) await resolveFromBatch(submissionId, linkedBatch, system);
    const submission = loadSubmission(db, submissionId)!;
    if (submission.state === 'accepted' && outcome !== 'skipped') await postAcceptSync(submission);
    return { outcome: submission.state === 'accepted' ? 'accepted' : outcome, submission };
  }

  function scheduleReplay(sub: SubmissionRow, base: Partial<SubmissionRow>, now: Date, state: 'outcome_unknown' | 'not_processed'): Outcome {
    const nextAt = addMs(now, replayDelay(sub.attempt_count));
    if (sub.attempt_count >= PAYOUT_LIMITS.maxSubmissionAttempts || nextAt >= sub.replay_deadline_at) {
      requireManualReconciliation(sub, 'No definite answer from PayPal Sandbox before the replay limit. An administrator must reconcile this submission.', base);
      return 'needs_manual_reconciliation';
    }
    const next = update(sub, { ...base, state, next_attempt_at: nextAt });
    audit(next, state === 'not_processed' ? 'payout.submission_not_processed' : 'payout.submission_outcome_unknown', 'succeeded',
      `${state === 'not_processed' ? 'PayPal Sandbox did not process the request' : 'No definite answer from PayPal Sandbox'}; the identical request will be replayed with the same keys.`,
      { state, nextAttemptAt: nextAt, attemptCount: next.attempt_count });
    return state;
  }

  /**
   * Accepts a submission from a PayPal batch only when the batch carries this submission's sender_batch_id exactly.
   * Used for duplicate-request links, webhook hints and administrator reconciliation.
   */
  async function resolveFromBatch(submissionId: string, providerBatchId: string, actor: AuditActor): Promise<boolean> {
    if (!deps.client) return false;
    const result = await deps.client.getBatch(providerBatchId);
    if (!result.ok) return false;
    const batch = parseBatch(result.body);
    if (!batch) return false;
    const accepted = db
      .transaction(() => {
        const sub = loadSubmission(db, submissionId)!;
        if (!['outcome_unknown', 'not_processed', 'needs_manual_reconciliation'].includes(sub.state)) return false;
        if (batch.senderBatchId !== sub.sender_batch_id) return false;
        recordAccepted(sub, batch.payoutBatchId, batch.rawBatchStatus, result.status, actor);
        return true;
      })
      .immediate();
    if (accepted) await postAcceptSync(loadSubmission(db, submissionId)!);
    return accepted;
  }

  async function postAcceptSync(sub: SubmissionRow) {
    try {
      await syncSubmissionBatch(deps, sub, 'post_submit');
    } catch (error) {
      logger.warn({ err: error, submissionId: sub.id }, 'Post-submission status read failed; the poller will retry');
    }
  }

  return {
    attemptOnce,
    resolveFromBatch,

    /** Sends right after approval, with up to two quick replays if the answer is unclear. */
    async sendAfterApproval(submissionId: string): Promise<SubmissionRow> {
      const started = Date.now();
      let { outcome, submission } = await attemptOnce(submissionId, 'approval');
      for (const delay of IMMEDIATE_REPLAY_DELAYS_MS) {
        if (outcome !== 'outcome_unknown' && outcome !== 'not_processed') break;
        if (Date.now() - started + delay > IMMEDIATE_BUDGET_MS) break;
        await sleep(delay);
        ({ outcome, submission } = await attemptOnce(submissionId, 'immediate replay'));
      }
      return submission;
    },

    /** Replays every submission whose next attempt is due. Called by the poller. */
    async processDue(): Promise<void> {
      const now = clock().toISOString();
      const due = db
        .prepare(
          `SELECT id FROM payout_submissions WHERE (state IN ('outcome_unknown', 'not_processed') AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
             OR (state IN ('outcome_unknown', 'not_processed') AND replay_deadline_at <= ?) ORDER BY next_attempt_at LIMIT 20`,
        )
        .all(now, now) as { id: string }[];
      for (const { id } of due) {
        try {
          await attemptOnce(id, 'scheduled replay');
        } catch (error) {
          logger.error({ err: error, submissionId: id }, 'Scheduled replay failed');
        }
      }
    },

    /** After a restart, a submission left in "sending" may or may not have reached PayPal: treat it as unknown. */
    recoverInterrupted(): number {
      const now = clock();
      const stuck = db.prepare("SELECT * FROM payout_submissions WHERE state = 'sending' AND (lease_until IS NULL OR lease_until <= ?)").all(now.toISOString()) as SubmissionRow[];
      for (const sub of stuck) {
        db.transaction(() => {
          const next = update(sub, { state: 'outcome_unknown', lease_until: null, next_attempt_at: now.toISOString() });
          audit(next, 'payout.submission_outcome_unknown', 'succeeded', 'The server stopped while sending. The identical request will be replayed with the same keys.');
        }).immediate();
      }
      return stuck.length;
    },

    /** Prepared submissions that were never sent (for example after a crash between approval and sending). */
    preparedIds(): string[] {
      return (db.prepare("SELECT id FROM payout_submissions WHERE state = 'prepared'").all() as { id: string }[]).map((r) => r.id);
    },
  };
}

export type SubmissionService = ReturnType<typeof createSubmissionService>;
