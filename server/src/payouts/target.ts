import { forPayPalTarget, type PayPalTarget } from '@shared/domain/payouts';
import { appendAudit } from '../audit/auditLog';
import { ConfigError } from '../config/env';
import type { Db } from '../db/connection';

type AuditInput = Parameters<typeof appendAudit>[1];

/** The PayPal target this database's payment actions are bound to, or null before the first Sandbox-mode start. */
export function boundPayPalTarget(db: Db): PayPalTarget | null {
  const row = db.prepare('SELECT target FROM paypal_target_binding WHERE id = 1').get() as { target: PayPalTarget } | undefined;
  return row?.target ?? null;
}

/**
 * Binds the database to the configured PayPal target on first use, or confirms it matches. A database that holds
 * local-stub records can never be pointed at the real PayPal Sandbox (or the reverse), so the two never mix.
 */
export function bindPayPalTarget(db: Db, target: PayPalTarget, apiBaseUrl: string, at: string): PayPalTarget {
  return db
    .transaction((): PayPalTarget => {
      const bound = boundPayPalTarget(db);
      if (bound === target) return bound;
      if (bound) {
        throw new ConfigError(
          bound === 'local_stub'
            ? 'This database holds payment actions made against a local PayPal stub, so it cannot be used with the real PayPal Sandbox. Use a new DATABASE_PATH or run npm run db:reset.'
            : 'This database holds genuine PayPal Sandbox payment actions, so it cannot be used with a local PayPal stub. Use a new DATABASE_PATH for stub testing.',
        );
      }
      const earlier = db.prepare('SELECT EXISTS (SELECT 1 FROM payout_submissions) OR EXISTS (SELECT 1 FROM payout_cancellations) AS any').get() as { any: number };
      if (earlier.any) {
        throw new ConfigError(
          'This database holds payment actions recorded before ReliefRelay tracked whether they went to PayPal Sandbox or a local stub, so they cannot be labelled reliably. Use a new DATABASE_PATH or run npm run db:reset.',
        );
      }
      db.prepare('INSERT INTO paypal_target_binding (id, target, api_host, bound_at) VALUES (1, ?, ?, ?)').run(target, new URL(apiBaseUrl).host, at);
      return target;
    })
    .immediate();
}

/** Rewords stored text for the bound target, so local-stub results never read as PayPal Sandbox results. */
export function targetText(db: Db, text: string): string {
  return forPayPalTarget(text, boundPayPalTarget(db));
}

/** Audit entry for a payment action, with its reason worded for the bound PayPal target. */
export function auditPayout(db: Db, entry: AuditInput) {
  return appendAudit(db, entry.reason ? { ...entry, reason: targetText(db, entry.reason) } : entry);
}

/**
 * Record fields that depend on the target. Local-stub results are stored as simulated so that existing timeline
 * and batch views (which label 'sandbox' records "PayPal Sandbox") never present them as PayPal Sandbox data.
 */
export function targetRecordFields(target: PayPalTarget | null) {
  const stub = target === 'local_stub';
  return {
    eventSource: stub ? ('simulation' as const) : ('sandbox' as const),
    batchProviderMode: stub ? null : ('sandbox' as const),
    recoveryProgramme: stub ? 'Local PayPal stub recovery (test only)' : 'PayPal Sandbox recovery',
  };
}
