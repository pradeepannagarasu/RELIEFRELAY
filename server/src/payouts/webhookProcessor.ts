import { parseBatch } from '../paypal/parse';
import { fetchItemStatus, syncSubmissionBatch, type PayoutDeps } from './statusSync';
import type { SubmissionService } from './submissions';
import type { SubmissionRow } from './records';

interface EventRow {
  event_id: string;
  event_type: string;
  resource_type: 'payout_item' | 'payout_batch' | 'other';
  provider_item_id: string | null;
  provider_batch_id: string | null;
  attempts: number;
}

const MAX_ATTEMPTS = 10;

/**
 * Processes verified webhook events. An event only says that something may have changed: the status is always
 * fetched from PayPal Sandbox and applied from that response, never from the webhook payload.
 */
export function createWebhookProcessor(deps: PayoutDeps & { submissions: SubmissionService }) {
  const { db, clock, logger } = deps;
  let running = false;

  const finish = (eventId: string, state: 'processed' | 'ignored' | 'failed' | 'pending', attempts: number, error: string | null = null) => {
    db.prepare('UPDATE paypal_webhook_events SET processing_state = ?, attempts = ?, processed_at = ?, last_error = ? WHERE event_id = ?').run(
      state,
      attempts,
      state === 'processed' || state === 'ignored' ? clock().toISOString() : null,
      error?.slice(0, 200) ?? null,
      eventId,
    );
  };

  /** Resolves an unknown submission from a batch ID only when the fetched batch carries its sender_batch_id exactly. */
  async function resolveUnknownFromBatch(providerBatchId: string): Promise<boolean> {
    if (!deps.client) return false;
    const result = await deps.client.getBatch(providerBatchId);
    if (!result.ok) return false;
    const batch = parseBatch(result.body);
    if (!batch?.senderBatchId) return false;
    const sub = db
      .prepare("SELECT * FROM payout_submissions WHERE sender_batch_id = ? AND state IN ('outcome_unknown', 'not_processed', 'needs_manual_reconciliation')")
      .get(batch.senderBatchId) as SubmissionRow | undefined;
    if (!sub) return false;
    return deps.submissions.resolveFromBatch(sub.id, providerBatchId, { type: 'system' });
  }

  async function handle(event: EventRow): Promise<'processed' | 'ignored'> {
    if (event.resource_type === 'payout_item' && event.provider_item_id) {
      const known = db
        .prepare(
          `SELECT recovery_item_id AS item_id FROM payout_submission_items WHERE provider_item_id = ? AND recovery_item_id IS NOT NULL
           UNION SELECT payment_item_id FROM provider_transactions WHERE mode = 'sandbox' AND provider_item_id = ?`,
        )
        .get(event.provider_item_id, event.provider_item_id) as { item_id: string } | undefined;
      if (known) {
        await fetchItemStatus(deps, { paymentItemId: known.item_id, source: 'webhook' });
        return 'processed';
      }
      if (event.provider_batch_id && (await resolveUnknownFromBatch(event.provider_batch_id))) return 'processed';
      return 'ignored';
    }
    if (event.resource_type === 'payout_batch' && event.provider_batch_id) {
      const sub = db.prepare("SELECT * FROM payout_submissions WHERE provider_batch_id = ? AND state = 'accepted'").get(event.provider_batch_id) as SubmissionRow | undefined;
      if (sub) {
        await syncSubmissionBatch(deps, sub, 'webhook');
        return 'processed';
      }
      return (await resolveUnknownFromBatch(event.provider_batch_id)) ? 'processed' : 'ignored';
    }
    return 'ignored';
  }

  return {
    async processPending(): Promise<number> {
      if (running) return 0;
      running = true;
      let processed = 0;
      try {
        const events = db
          .prepare("SELECT * FROM paypal_webhook_events WHERE processing_state IN ('pending', 'failed') AND attempts < ? ORDER BY received_at LIMIT 20")
          .all(MAX_ATTEMPTS) as EventRow[];
        for (const event of events) {
          const attempts = event.attempts + 1;
          try {
            if (!deps.client) {
              finish(event.event_id, 'pending', event.attempts, 'PayPal Sandbox is not configured.');
              continue;
            }
            const outcome = await handle(event);
            finish(event.event_id, outcome, attempts);
            processed += 1;
          } catch (error) {
            logger.warn({ err: error, eventId: event.event_id }, 'Webhook event processing failed');
            finish(event.event_id, attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, error instanceof Error ? error.message : 'Processing failed');
          }
        }
      } finally {
        running = false;
      }
      return processed;
    },
  };
}

export type WebhookProcessor = ReturnType<typeof createWebhookProcessor>;
