import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express, type Request } from 'express';
import type { Logger } from 'pino';
import type { Db } from '../db/connection';
import type { WebhookHeaders, WebhookVerifier } from './webhookVerifier';

/**
 * The PayPal webhook listener: a separate Express app on its own port, so the raw body can be verified byte for byte
 * before anything is parsed. Responses follow PayPal's delivery rules: any 2xx acknowledges the delivery; anything
 * else makes PayPal retry (up to 25 times over 3 days). Verified and duplicate deliveries get 200; a failed signature
 * gets 400; a delivery that could not be stored gets 503 so PayPal retries it.
 */

export const WEBHOOK_PATH = '/paypal/webhooks';
const MAX_BODY = '64kb';

export interface WebhookServerOptions {
  db: Db;
  verify: WebhookVerifier;
  logger: Logger;
  clock: () => Date;
  /** Development only: write each raw delivery (headers, body and certificate) here to build a verification fixture. */
  captureDir?: string;
  /** Called after a verified, newly stored event, to process it without delaying the acknowledgement. */
  onEventStored?: () => void;
}

const header = (req: Request, name: string) => {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
};

export function readWebhookHeaders(req: Request): WebhookHeaders {
  return {
    transmissionId: header(req, 'paypal-transmission-id'),
    transmissionTime: header(req, 'paypal-transmission-time'),
    transmissionSig: header(req, 'paypal-transmission-sig'),
    certUrl: header(req, 'paypal-cert-url'),
    authAlgo: header(req, 'paypal-auth-algo'),
  };
}

interface EventSummary {
  eventId: string;
  eventType: string;
  resourceType: 'payout_item' | 'payout_batch' | 'other';
  providerItemId: string | null;
  providerBatchId: string | null;
}

const ID = /^[A-Za-z0-9-]{1,64}$/;

/** Reads identifiers from a verified event. Statuses in the payload are deliberately ignored. */
export function summariseEvent(body: unknown): EventSummary | null {
  if (!body || typeof body !== 'object') return null;
  const event = body as { id?: unknown; event_type?: unknown; resource?: Record<string, unknown> };
  if (typeof event.id !== 'string' || event.id.length < 1 || event.id.length > 100) return null;
  if (typeof event.event_type !== 'string' || event.event_type.length > 100) return null;
  const resource = event.resource && typeof event.resource === 'object' ? event.resource : {};
  const str = (v: unknown) => (typeof v === 'string' && ID.test(v) ? v : null);
  if (event.event_type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
    return { eventId: event.id, eventType: event.event_type, resourceType: 'payout_item', providerItemId: str(resource.payout_item_id), providerBatchId: str(resource.payout_batch_id) };
  }
  if (event.event_type.startsWith('PAYMENT.PAYOUTSBATCH.')) {
    const headerObj = resource.batch_header && typeof resource.batch_header === 'object' ? (resource.batch_header as Record<string, unknown>) : {};
    return { eventId: event.id, eventType: event.event_type, resourceType: 'payout_batch', providerItemId: null, providerBatchId: str(headerObj.payout_batch_id) };
  }
  return { eventId: event.id, eventType: event.event_type, resourceType: 'other', providerItemId: null, providerBatchId: null };
}

export function createWebhookApp({ db, verify, logger, clock, captureDir, onEventStored }: WebhookServerOptions): Express {
  const app = express();
  app.disable('x-powered-by');

  app.post(WEBHOOK_PATH, express.raw({ type: () => true, limit: MAX_BODY }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const headers = readWebhookHeaders(req);
    const receivedAt = clock().toISOString();
    const bodySha = createHash('sha256').update(raw).digest('hex');

    const result = await verify(raw, headers);

    if (captureDir) {
      try {
        mkdirSync(captureDir, { recursive: true });
        const name = `${receivedAt.replace(/[:.]/g, '-')}-${(headers.transmissionId ?? 'unknown').replace(/[^A-Za-z0-9-]/g, '')}.json`;
        writeFileSync(
          join(captureDir, name),
          JSON.stringify({ capturedAt: receivedAt, verification: result.ok ? 'verified' : result.code, headers, bodyBase64: raw.toString('base64'), certPem: result.ok ? result.certPem : null }, null, 2),
        );
      } catch (error) {
        logger.warn({ err: error }, 'Could not write webhook capture');
      }
    }

    let summary: EventSummary | null = null;
    if (result.ok) {
      try {
        summary = summariseEvent(JSON.parse(raw.toString('utf8')));
      } catch {
        summary = null;
      }
    }

    try {
      const outcome = db
        .transaction((): 'verified' | 'duplicate' | 'failed' | 'new_event' => {
          const insert = db.prepare(
            `INSERT INTO paypal_webhook_transmissions (transmission_id, event_id, event_type, verification, failure_code, body_sha256, body_bytes, cert_host, transmission_time, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          const common = [bodySha, raw.length, result.certHost, headers.transmissionTime?.slice(0, 40) ?? null, receivedAt] as const;
          if (!result.ok) {
            insert.run(headers.transmissionId?.slice(0, 100) ?? null, null, null, 'failed', result.code, ...common);
            return 'failed';
          }
          if (!summary) {
            insert.run(headers.transmissionId!, null, null, 'failed', 'unrecognised_event', ...common);
            return 'failed';
          }
          const seen = db.prepare("SELECT 1 FROM paypal_webhook_transmissions WHERE transmission_id = ? AND verification = 'verified'").get(headers.transmissionId!);
          if (seen) {
            insert.run(headers.transmissionId!, summary.eventId, summary.eventType, 'duplicate', null, ...common);
            return 'duplicate';
          }
          const seq = Number(insert.run(headers.transmissionId!, summary.eventId, summary.eventType, 'verified', null, ...common).lastInsertRowid);
          const stored = db
            .prepare(
              `INSERT OR IGNORE INTO paypal_webhook_events (event_id, event_type, resource_type, provider_item_id, provider_batch_id, first_transmission_seq, received_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(summary.eventId, summary.eventType, summary.resourceType, summary.providerItemId, summary.providerBatchId, seq, receivedAt);
          return stored.changes > 0 ? 'new_event' : 'verified';
        })
        .immediate();

      if (outcome === 'failed') {
        logger.warn({ code: result.ok ? 'unrecognised_event' : result.code }, 'PayPal webhook rejected');
        res.status(400).json({ error: 'verification_failed' });
        return;
      }
      res.status(200).json({ received: true });
      if (outcome === 'new_event') setImmediate(() => onEventStored?.());
    } catch (error) {
      logger.error({ err: error }, 'PayPal webhook could not be stored; PayPal will retry');
      res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use((error: { status?: number }, _req: Request, res: express.Response, _next: express.NextFunction) => {
    const status = error.status === 413 ? 413 : 400;
    res.status(status).json({ error: status === 413 ? 'payload_too_large' : 'bad_request' });
  });
  return app;
}
