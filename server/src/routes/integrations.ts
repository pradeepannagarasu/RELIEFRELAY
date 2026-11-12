import { Router } from 'express';
import { z } from 'zod';
import type { AuditListResponse, ConnectionCheckResult, PayPalIntegrationResponse } from '@shared/api/contracts';
import { forPayPalTarget, PAYOUT_CURRENCIES, PAYOUT_LIMITS, SANDBOX_NOTICE } from '@shared/domain/payouts';
import { appendAudit, type AuditEventRow } from '../audit/auditLog';
import type { AppConfig } from '../config/env';
import type { Db } from '../db/connection';
import { AppError } from '../lib/errors';
import { parseInput, requestContext } from '../lib/validation';
import type { PayPalClient } from '../paypal/client';
import { listEntries } from '../payouts/allowlist';
import { auditActor, auditRejection } from '../services/context';
import { auditEntryView } from '../payouts/views';

const PAYOUTS_SCOPE = 'https://uri.paypal.com/payments/payouts';

/** Read-only PayPal Sandbox settings, plus an administrator connection check that never reveals credentials. */
export function integrationsRouter(db: Db, config: AppConfig, client: PayPalClient | null, clock: () => Date): Router {
  const router = Router();
  let lastCheck: ConnectionCheckResult | null = null;
  const target = config.paypal.target;

  router.get('/paypal', (req, res) => {
    const ctx = requestContext(req);
    const recent = db
      .prepare('SELECT seq, event_type, verification, failure_code, received_at FROM paypal_webhook_transmissions ORDER BY seq DESC LIMIT 10')
      .all() as { seq: number; event_type: string | null; verification: 'verified' | 'failed' | 'duplicate'; failure_code: string | null; received_at: string }[];
    const lastVerified = db.prepare("SELECT max(received_at) AS at FROM paypal_webhook_transmissions WHERE verification = 'verified'").get() as { at: string | null };
    const body: PayPalIntegrationResponse = {
      sandboxNotice: forPayPalTarget(SANDBOX_NOTICE, target),
      target,
      providerMode: config.providerMode,
      apiHost: new URL(config.paypal.apiBaseUrl).host,
      configured: !!client,
      payoutsEnabled: config.providerMode === 'sandbox' && config.paypal.payoutsEnabled,
      webhook: {
        configured: !!config.paypal.webhookId,
        port: config.paypal.webhookPort,
        lastVerifiedAt: lastVerified.at,
        recent: recent.map((r) => ({ seq: r.seq, eventType: r.event_type, verification: r.verification, failureCode: r.failure_code, receivedAt: r.received_at })),
      },
      allowlist: listEntries(db, ctx.actor.organisationId).map((e) => ({ receiverMasked: e.receiver_masked, label: e.label, active: !e.deactivated_at, addedAt: e.added_at })),
      limits: {
        currencies: PAYOUT_CURRENCIES,
        maxPerPayoutMinor: PAYOUT_LIMITS.maxPerPayoutMinor,
        maxPayoutsPerDay: PAYOUT_LIMITS.maxPayoutsPerDay,
        maxValuePerCurrencyPerDayMinor: PAYOUT_LIMITS.maxValuePerCurrencyPerDayMinor,
        proposalExpiryHours: PAYOUT_LIMITS.proposalExpiryHours,
        maxRecoveryAttempts: PAYOUT_LIMITS.maxRecoveryAttempts,
      },
      lastConnectionCheck: lastCheck,
      canRunConnectionCheck: ctx.actor.user.role === 'admin' && !!client,
    };
    res.json(body);
  });

  router.post('/paypal/connection-check', async (req, res) => {
    const ctx = requestContext(req);
    if (ctx.actor.user.role !== 'admin') {
      auditRejection(db, ctx, 'paypal.connection_checked', 'integration', 'paypal', 'Only an administrator can run the connection check.');
      throw new AppError('forbidden', 'Only an administrator can run the connection check.');
    }
    if (!client) throw new AppError('conflict', 'PayPal Sandbox is not configured on this server.');
    const result = await client.checkCredentials();
    const checkedAt = clock().toISOString();
    const detail = result.ok
      ? result.scopes.includes(PAYOUTS_SCOPE)
        ? 'PayPal Sandbox accepted the credentials and granted the Payouts scope.'
        : 'PayPal Sandbox accepted the credentials, but the Payouts scope was not granted. Enable Payouts for this Sandbox app.'
      : `PayPal Sandbox did not accept the credentials (${result.name ?? (result.status === null ? 'no response' : `HTTP ${result.status}`)}).`;
    lastCheck = { ok: result.ok, checkedAt, detail: forPayPalTarget(detail, target) };
    appendAudit(db, {
      organisationId: ctx.actor.organisationId,
      actor: auditActor(ctx),
      action: 'paypal.connection_checked',
      entityType: 'integration',
      entityId: 'paypal',
      outcome: 'succeeded',
      requestId: ctx.requestId,
      newState: { ok: lastCheck.ok },
      reason: lastCheck.detail,
    });
    res.json(lastCheck);
  });

  return router;
}

const AuditQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(50),
  action: z.string().regex(/^[a-z_]+\.[a-z_]+$/).optional(),
  outcome: z.enum(['succeeded', 'rejected']).optional(),
  entityType: z.string().regex(/^[a-z_]{1,40}$/).optional(),
});

/** Audit history for the organisation, newest first. Read-only. */
export function auditRouter(db: Db): Router {
  const router = Router();
  router.get('/', (req, res) => {
    const ctx = requestContext(req);
    const query = parseInput(AuditQuery, req.query, 'audit filter');
    const where = ['organisation_id = ?'];
    const params: (string | number)[] = [ctx.actor.organisationId];
    if (query.action) {
      where.push('action = ?');
      params.push(query.action);
    }
    if (query.outcome) {
      where.push('outcome = ?');
      params.push(query.outcome);
    }
    if (query.entityType) {
      where.push('entity_type = ?');
      params.push(query.entityType);
    }
    const clause = where.join(' AND ');
    const total = (db.prepare(`SELECT count(*) AS n FROM audit_events WHERE ${clause}`).get(...params) as { n: number }).n;
    const rows = db
      .prepare(`SELECT * FROM audit_events WHERE ${clause} ORDER BY seq DESC LIMIT ? OFFSET ?`)
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as AuditEventRow[];
    const actions = (db.prepare('SELECT DISTINCT action FROM audit_events WHERE organisation_id = ? ORDER BY action').all(ctx.actor.organisationId) as { action: string }[]).map(
      (r) => r.action,
    );
    const body: AuditListResponse = {
      entries: rows.map((row) => ({ ...auditEntryView(db, row), entityType: row.entity_type, entityId: row.entity_id, requestId: row.request_id })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      actions,
    };
    res.json(body);
  });
  return router;
}
