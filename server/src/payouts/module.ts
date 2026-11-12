import type { Logger } from 'pino';
import type { AppConfig } from '../config/env';
import type { Db } from '../db/connection';
import { createPayPalClient, type PayPalClient } from '../paypal/client';
import { createWebhookVerifier, type CertFetcher } from '../paypal/webhookVerifier';
import { createCancellationService } from './cancellations';
import type { PayoutEnvironment } from './eligibility';
import { createPayoutService } from './payoutService';
import { MINUTE, type SubmissionRow } from './records';
import { fetchItemStatus, refreshSubmissionBatchStatus, syncSubmissionBatch, type PayoutDeps } from './statusSync';
import { createSubmissionService } from './submissions';
import { bindPayPalTarget } from './target';
import { createWebhookProcessor } from './webhookProcessor';

export interface PayoutModuleOptions {
  db: Db;
  config: AppConfig;
  clock: () => Date;
  logger: Logger;
  /** Override the PayPal client (tests use a stub server through the real client instead). */
  client?: PayPalClient | null;
  fetchCert?: CertFetcher;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum time between polls of a PENDING or UNCLAIMED/ONHOLD recovery item (defaults: 10 and 60 minutes). */
  pollPendingMs?: number;
  pollUnclaimedMs?: number;
}

const POLL_PENDING_MS = 10 * MINUTE;
const POLL_UNCLAIMED_MS = 60 * MINUTE;
const BATCH_FOLLOW_UP_MS = 3 * 24 * 60 * MINUTE;

export function createPayoutModule(options: PayoutModuleOptions) {
  const { db, config, clock, logger } = options;
  const configured = !!(config.paypal.clientId && config.paypal.clientSecret);
  const client =
    options.client !== undefined
      ? options.client
      : config.providerMode === 'sandbox' && configured
        ? createPayPalClient({ baseUrl: config.paypal.apiBaseUrl, clientId: config.paypal.clientId!, clientSecret: config.paypal.clientSecret!, clock })
        : null;
  const environment = (): PayoutEnvironment => ({ providerMode: config.providerMode, configured: configured && !!client, payoutsEnabled: config.paypal.payoutsEnabled });
  const payoutsEnabled = () => config.providerMode === 'sandbox' && config.paypal.payoutsEnabled;
  const deps: PayoutDeps = { db, clock, client, logger };
  if (config.providerMode === 'sandbox' && client) bindPayPalTarget(db, config.paypal.target, config.paypal.apiBaseUrl, clock().toISOString());

  const submissions = createSubmissionService({ ...deps, payoutsEnabled, sleep: options.sleep });
  const cancellations = createCancellationService({ ...deps, payoutsEnabled });
  const service = createPayoutService({ ...deps, environment, submissions, cancellations });
  const webhookProcessor = createWebhookProcessor({ ...deps, submissions });
  const verifyWebhook = createWebhookVerifier({ webhookId: config.paypal.webhookId, fetchCert: options.fetchCert, clock });

  /** Polls accepted recovery payouts whose item status is not final. Read-only: never sends a payment. */
  async function pollOpenItems(): Promise<void> {
    const now = clock().getTime();
    const subs = db
      .prepare(
        `SELECT s.* FROM payout_submissions s JOIN payout_submission_items si ON si.submission_id = s.id
         LEFT JOIN provider_transactions p ON p.payment_item_id = si.recovery_item_id
         WHERE s.state = 'accepted' AND (p.status IS NULL OR p.status IN ('PENDING', 'UNCLAIMED', 'ONHOLD'))
         LIMIT 20`,
      )
      .all() as SubmissionRow[];
    for (const sub of subs) {
      const item = db
        .prepare('SELECT si.recovery_item_id, si.provider_item_id, p.status, p.updated_at FROM payout_submission_items si LEFT JOIN provider_transactions p ON p.payment_item_id = si.recovery_item_id WHERE si.submission_id = ?')
        .get(sub.id) as { recovery_item_id: string; provider_item_id: string | null; status: string | null; updated_at: string | null };
      const interval = item.status === 'UNCLAIMED' || item.status === 'ONHOLD' ? (options.pollUnclaimedMs ?? POLL_UNCLAIMED_MS) : (options.pollPendingMs ?? POLL_PENDING_MS);
      if (item.updated_at && Date.parse(item.updated_at) > now - interval) continue;
      try {
        if (item.provider_item_id) await fetchItemStatus(deps, { paymentItemId: item.recovery_item_id, source: 'poll' });
        else await syncSubmissionBatch(deps, sub, 'poll');
      } catch (error) {
        logger.warn({ err: error, submissionId: sub.id }, 'Status poll failed');
      }
    }
    await pollOpenBatches(now);
  }

  const lastBatchRead = new Map<string, number>();

  /**
   * Item reads do not return the batch status, so a batch recorded as PENDING or PROCESSING when it was accepted is
   * re-read once its item has moved on. Stops BATCH_FOLLOW_UP_MS after the item last changed. Read-only.
   */
  async function pollOpenBatches(now: number): Promise<void> {
    const subs = db
      .prepare(
        `SELECT s.* FROM payout_submissions s
         JOIN payout_submission_items si ON si.submission_id = s.id
         JOIN payment_batches b ON b.id = s.recovery_batch_id
         JOIN provider_transactions p ON p.payment_item_id = si.recovery_item_id
         WHERE s.state = 'accepted' AND s.provider_batch_id IS NOT NULL
           AND p.status IS NOT NULL AND p.status <> 'PENDING'
           AND (b.provider_status IS NULL OR b.provider_status IN ('PENDING', 'PROCESSING'))
           AND p.updated_at > ?
         LIMIT 20`,
      )
      .all(new Date(now - BATCH_FOLLOW_UP_MS).toISOString()) as SubmissionRow[];
    const interval = options.pollPendingMs ?? POLL_PENDING_MS;
    for (const sub of subs) {
      if ((lastBatchRead.get(sub.id) ?? 0) > now - interval) continue;
      lastBatchRead.set(sub.id, now);
      try {
        await refreshSubmissionBatchStatus(deps, sub);
      } catch (error) {
        logger.warn({ err: error, submissionId: sub.id }, 'Batch status poll failed');
      }
    }
  }

  let timer: NodeJS.Timeout | null = null;
  let ticking = false;

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      service.expireDue();
      if (client) {
        for (const id of submissions.preparedIds()) await submissions.attemptOnce(id, 'resumed after restart');
        await submissions.processDue();
        await cancellations.processDue();
        await webhookProcessor.processPending();
        await pollOpenItems();
      }
    } catch (error) {
      logger.error({ err: error }, 'Payout worker tick failed');
    } finally {
      ticking = false;
    }
  }

  return {
    client,
    environment,
    service,
    submissions,
    cancellations,
    webhookProcessor,
    verifyWebhook,
    tick,
    /** Starts the background worker. A send interrupted by a restart is treated as an unknown outcome and replayed with the same keys. */
    start() {
      if (config.providerMode !== 'sandbox' || !client || timer) return;
      const recovered = submissions.recoverInterrupted();
      if (recovered > 0) logger.warn({ recovered }, 'Submissions interrupted while sending are now outcome unknown');
      timer = setInterval(() => void tick(), config.paypal.pollIntervalMs);
      timer.unref();
      void tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type PayoutModule = ReturnType<typeof createPayoutModule>;
