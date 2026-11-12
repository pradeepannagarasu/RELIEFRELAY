import { randomUUID } from 'node:crypto';
import { PAYOUT_LIMITS } from '@shared/domain/payouts';
import { auditPayout } from './target';
import { addMs, loadCancellation, MINUTE, type CancellationRow, type StatusCheckRow } from './records';
import { fetchItemStatus, type PayoutDeps } from './statusSync';

const FINAL = new Set(['succeeded', 'already_cancelled', 'not_applicable']);
const LEASE_MS = 60_000;
const RETRY_MS = 5 * MINUTE;

/**
 * Approved cancellations of unclaimed Sandbox payouts. PayPal documents no idempotency key for cancelling an item,
 * so every send is preceded by a new status check showing the item as UNCLAIMED, an unclear outcome is resolved by
 * fetching the status (never by resending blindly), and at most three sends happen within 24 hours of approval.
 */
export function createCancellationService(deps: PayoutDeps & { payoutsEnabled: () => boolean }) {
  const { db, clock, logger } = deps;

  const update = (can: CancellationRow, fields: Partial<CancellationRow>) => {
    const entries = Object.entries(fields);
    db.prepare(`UPDATE payout_cancellations SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, version = version + 1 WHERE id = ? AND version = ?`).run(
      ...entries.map(([, v]) => v as string | number | null),
      can.id,
      can.version,
    );
    const next = loadCancellation(db, can.id)!;
    if (next.version !== can.version + 1) throw new Error('Cancellation changed concurrently.');
    return next;
  };

  const audit = (can: CancellationRow, action: string, reason: string, newState?: unknown) =>
    auditPayout(db, {
      organisationId: can.organisation_id,
      actor: { type: 'system' },
      action,
      entityType: 'payout_cancellation',
      entityId: can.id,
      outcome: 'succeeded',
      newState: newState ?? { state: can.state, sendCount: can.send_count },
      reason: reason.slice(0, 500),
    });

  const refusedByPayPal = (status: number | null) => status !== null && status >= 400 && status < 500 && status !== 429 && status !== 401;

  /** Settles a cancellation from a status check. Returns true when a send should follow. Call inside a transaction. */
  const settle = (can: CancellationRow, check: StatusCheckRow | null, now: Date): { send: boolean; can: CancellationRow } => {
    const at = now.toISOString();
    if (!check || check.outcome !== 'ok') {
      const next = update(can, {
        state: can.send_count > 0 ? 'outcome_unknown' : 'not_processed',
        lease_until: null,
        next_attempt_at: addMs(now, RETRY_MS),
        last_status_check_id: check?.id ?? can.last_status_check_id,
      });
      audit(next, 'payout.cancellation_status_unavailable', 'The item status could not be read from PayPal Sandbox. Nothing further is sent until it can be.');
      return { send: false, can: next };
    }
    const base = { lease_until: null, next_attempt_at: null, last_status_check_id: check.id };
    if (check.item_status === 'RETURNED') {
      const sent = can.send_count > 0;
      const next = update(can, {
        ...base,
        state: sent ? 'succeeded' : 'already_cancelled',
        resolved_by: sent && can.last_http_status !== null && can.last_http_status >= 200 && can.last_http_status < 300 ? 'cancel_response' : 'status_check',
        completed_at: at,
      });
      audit(next, sent ? 'payout.cancellation_succeeded' : 'payout.cancellation_already_cancelled', 'PayPal Sandbox shows the recovery payout as RETURNED.');
      return { send: false, can: next };
    }
    if (check.item_status !== 'UNCLAIMED') {
      const next = update(can, { ...base, state: 'not_applicable', completed_at: at });
      audit(next, 'payout.cancellation_not_applicable', `PayPal Sandbox reports the payout as ${check.item_status}, so it is no longer unclaimed. Nothing was cancelled.`);
      return { send: false, can: next };
    }
    if (can.send_count > 0 && refusedByPayPal(can.last_http_status)) {
      const next = update(can, { ...base, state: 'needs_manual_reconciliation' });
      audit(next, 'payout.cancellation_needs_reconciliation', `PayPal Sandbox refused the cancellation (${can.last_error_name ?? `HTTP ${can.last_http_status}`}) and the payout is still unclaimed.`);
      return { send: false, can: next };
    }
    if (can.send_count >= PAYOUT_LIMITS.maxCancellationSends || at >= can.send_deadline_at) {
      const next = update(can, { ...base, state: 'needs_manual_reconciliation' });
      audit(next, 'payout.cancellation_needs_reconciliation', 'The payout is still unclaimed after the permitted sends or the approval window ended.');
      return { send: false, can: next };
    }
    if (!deps.payoutsEnabled() || !deps.client) {
      const next = update(can, { ...base, state: can.send_count > 0 ? 'outcome_unknown' : 'not_processed', next_attempt_at: addMs(now, RETRY_MS) });
      audit(next, 'payout.cancellation_paused', 'Payment actions are switched off on this server. Nothing was sent.');
      return { send: false, can: next };
    }
    const next = update(can, {
      state: 'sending',
      precheck_status_check_id: check.id,
      sent_with_check_id: check.id,
      last_status_check_id: check.id,
      send_count: can.send_count + 1,
      last_sent_at: at,
      lease_until: addMs(now, LEASE_MS),
      next_attempt_at: null,
    });
    audit(next, 'payout.cancellation_sent', `Cancellation sent to PayPal Sandbox (send ${next.send_count} of ${PAYOUT_LIMITS.maxCancellationSends}) after a new status check showed UNCLAIMED.`);
    return { send: true, can: next };
  };

  /** One step: check the status, then send if it is still unclaimed. Returns true if another step should follow now. */
  async function step(id: string): Promise<boolean> {
    const now = clock();
    const claimed = db
      .transaction(() => {
        const can = loadCancellation(db, id);
        if (!can || FINAL.has(can.state) || can.state === 'needs_manual_reconciliation') return null;
        if (can.lease_until && can.lease_until > now.toISOString()) return null;
        return update(can, { state: 'prechecking', lease_until: addMs(now, LEASE_MS) });
      })
      .immediate();
    if (!claimed) return false;

    let check: StatusCheckRow | null = null;
    try {
      check = await fetchItemStatus(deps, { paymentItemId: claimed.target_item_id, source: claimed.send_count > 0 ? 'confirm' : 'precheck', context: 'cancellation' });
    } catch (error) {
      logger.warn({ err: error, cancellationId: id }, 'Cancellation status check failed');
    }
    const decision = db.transaction(() => settle(loadCancellation(db, id)!, check, clock())).immediate();
    if (!decision.send) return false;

    const result = await deps.client!.cancelItem(decision.can.provider_item_id);
    return db
      .transaction(() => {
        const can = loadCancellation(db, id)!;
        if (can.state !== 'sending') return false;
        const nowAfter = clock();
        const base = { lease_until: null, last_http_status: result.status, last_debug_id: result.debugId, last_error_name: result.ok ? null : result.name };
        if (!result.ok && (result.status === 429 || result.status === 401)) {
          const next = update(can, { ...base, state: 'not_processed', next_attempt_at: addMs(nowAfter, RETRY_MS) });
          audit(next, 'payout.cancellation_not_processed', 'PayPal Sandbox did not process the cancellation. The status is checked again before any further send.');
          return false;
        }
        // Success, refusal or no clear answer: in every case the next step fetches the status before anything else.
        const next = update(can, { ...base, state: 'outcome_unknown', next_attempt_at: nowAfter.toISOString() });
        audit(
          next,
          'payout.cancellation_response',
          result.ok ? 'PayPal Sandbox answered the cancellation; confirming the item status.' : `PayPal Sandbox answered ${result.status ?? 'without a response'}; confirming the item status.`,
          { state: next.state, httpStatus: result.status },
        );
        return true;
      })
      .immediate();
  }

  return {
    step,
    /** Runs the cancellation right after approval: check, send, confirm. */
    async runAfterApproval(id: string): Promise<CancellationRow> {
      for (let i = 0; i < 4; i += 1) {
        if (!(await step(id))) break;
      }
      return loadCancellation(db, id)!;
    },
    async processDue(): Promise<void> {
      const now = clock().toISOString();
      const due = db
        .prepare(
          `SELECT id FROM payout_cancellations
           WHERE (state IN ('prepared', 'not_processed', 'outcome_unknown') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
              OR (state IN ('prechecking', 'sending') AND (lease_until IS NULL OR lease_until <= ?))
           LIMIT 20`,
        )
        .all(now, now) as { id: string }[];
      for (const { id } of due) {
        try {
          for (let i = 0; i < 3; i += 1) if (!(await step(id))) break;
        } catch (error) {
          logger.error({ err: error, cancellationId: id }, 'Cancellation step failed');
        }
      }
    },
    /** Administrator re-check of a cancellation that needs manual reconciliation. */
    async recheck(id: string, userId: string): Promise<CancellationRow> {
      const can = loadCancellation(db, id)!;
      const check = await fetchItemStatus(deps, { paymentItemId: can.target_item_id, source: 'reconcile', requestedByUserId: userId, context: 'cancellation' });
      return db
        .transaction(() => {
          const current = loadCancellation(db, id)!;
          if (current.state !== 'needs_manual_reconciliation') return current;
          const at = clock().toISOString();
          db.prepare(
            `INSERT INTO payout_reconciliations (id, organisation_id, cancellation_id, action, user_id, recorded_at) VALUES (?, ?, ?, 'status_recheck', ?, ?)`,
          ).run(`rec_${randomUUID()}`, current.organisation_id, id, userId, at);
          if (check.outcome !== 'ok') return current;
          const returned = check.item_status === 'RETURNED';
          const next = update(current, {
            state: returned ? (current.send_count > 0 ? 'succeeded' : 'already_cancelled') : 'not_applicable',
            resolved_by: returned ? 'status_check' : null,
            completed_at: at,
            last_status_check_id: check.id,
            lease_until: null,
            next_attempt_at: null,
          });
          auditPayout(db, {
            organisationId: current.organisation_id,
            actor: { type: 'user', userId, role: 'admin' },
            action: 'payout.cancellation_reconciled',
            entityType: 'payout_cancellation',
            entityId: id,
            outcome: 'succeeded',
            previousState: { state: current.state },
            newState: { state: next.state, itemStatus: check.item_status },
            reason: `Administrator re-checked the status: PayPal Sandbox reports ${check.item_status}.`,
          });
          return next;
        })
        .immediate();
    },
  };
}

export type CancellationService = ReturnType<typeof createCancellationService>;
