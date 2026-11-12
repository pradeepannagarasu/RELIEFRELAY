import { randomUUID } from 'node:crypto';
import { isPayoutCurrency, PAYOUT_LIMITS, type PayoutCurrency } from '@shared/domain/payouts';
import { appendAudit } from '../audit/auditLog';
import type { Db } from '../db/connection';
import { paymentFingerprint } from '../lib/paymentIdentity';
import { nextCaseReference } from '../services/caseReferences';
import { findActiveEntry, normaliseAllowlistEmail } from './allowlist';
import { DAY, insertPaymentEvent } from './records';

/** How a scenario is labelled. The defaults describe the PayPal Sandbox demonstration. */
export interface DemoScenarioLabels {
  programme: string;
  /** Reference segment: batches are RR-B-<prefix>-<n>, payments RR-P-<prefix>-<n>. */
  referencePrefix: string;
  /** Names the demonstration in case and timeline text, e.g. "Sandbox demonstration". */
  context: string;
  auditAction: string;
  auditReason: string;
}

export interface DemoScenarioInput {
  organisationId: string;
  receiver: string;
  amountMinor: number;
  currency: PayoutCurrency;
  now: Date;
  labels?: DemoScenarioLabels;
}

export interface DemoScenarioResult {
  caseId: string;
  caseReference: string;
  paymentReference: string;
  batchReference: string;
}

export const DEMO_PROGRAMME = 'Sandbox demonstration (synthetic)';
const SIMULATED_NOTE = 'The original payment is simulated: no request was ever sent to PayPal for it.';

const SANDBOX_LABELS: DemoScenarioLabels = {
  programme: DEMO_PROGRAMME,
  referencePrefix: 'DEMO-SBX',
  context: 'Sandbox demonstration',
  auditAction: 'demo.sandbox_scenario_created',
  auditReason: 'Created by npm run sandbox:demo-scenario.',
};

/**
 * Creates a new, clearly labelled synthetic payment whose simulated provider record is RETURNED, and opens a case for
 * it, so the normal propose and approve flow can send a genuine PayPal Sandbox recovery payout. Only inserts new rows:
 * existing seeded cases are never touched, and nothing is sent to PayPal here.
 */
export function createDemoScenario(db: Db, input: DemoScenarioInput): DemoScenarioResult {
  const labels = input.labels ?? SANDBOX_LABELS;
  const receiver = normaliseAllowlistEmail(input.receiver);
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1 || input.amountMinor > PAYOUT_LIMITS.maxPerPayoutMinor) {
    throw new Error(`The amount must be between 0.01 and ${PAYOUT_LIMITS.maxPerPayoutMinor / 100}.`);
  }
  if (!isPayoutCurrency(input.currency)) throw new Error('The currency must be GBP, USD or EUR.');
  if (!/^[A-Z0-9-]{1,20}$/.test(labels.referencePrefix)) throw new Error('Invalid reference prefix.');

  return db
    .transaction((): DemoScenarioResult => {
      const entry = findActiveEntry(db, input.organisationId, 'EMAIL', receiver);
      if (!entry || entry.receiver_value !== receiver) {
        throw new Error('The receiver must exactly match an active entry on the Sandbox receiver allowlist (npm run paypal:receivers -- list).');
      }
      const admin = db.prepare("SELECT id FROM users WHERE organisation_id = ? AND role = 'admin' ORDER BY id LIMIT 1").get(input.organisationId) as { id: string } | undefined;
      if (!admin) throw new Error('The organisation has no administrator account.');
      const used = db.prepare('SELECT count(*) AS n FROM payment_batches WHERE organisation_id = ? AND reference LIKE ?').get(input.organisationId, `RR-B-${labels.referencePrefix}-%`) as { n: number };
      const n = used.n + 1;
      const batchReference = `RR-B-${labels.referencePrefix}-${n}`;
      const paymentReference = `RR-P-${labels.referencePrefix}-${n}`;
      const recipientReference = `BEN-${labels.referencePrefix}-${n}`;
      const now = input.now.toISOString();
      const submittedAt = new Date(input.now.getTime() - 2 * DAY).toISOString();
      const returnedAt = new Date(input.now.getTime() - DAY).toISOString();

      const batchId = `bat_${randomUUID()}`;
      db.prepare(
        `INSERT INTO payment_batches (id, organisation_id, reference, kind, origin, programme, sender_batch_id, provider_mode, provider_batch_id, provider_status,
           submitted_at, created_by_user_id, created_at)
         VALUES (?, ?, ?, 'disbursement', 'provider_submission', ?, ?, 'simulation', ?, 'SUCCESS', ?, ?, ?)`,
      ).run(batchId, input.organisationId, batchReference, labels.programme, `SIM-${labels.referencePrefix}-${n}`, `SIM-BATCH-${labels.referencePrefix}-${n}`, submittedAt, admin.id, now);

      const itemId = `itm_${randomUUID()}`;
      db.prepare(
        `INSERT INTO payment_items (id, organisation_id, batch_id, payment_reference, recipient_reference, receiver_type, receiver_value, receiver_masked,
           amount_minor, currency, fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, 'EMAIL', ?, ?, ?, ?, ?, ?)`,
      ).run(
        itemId,
        input.organisationId,
        batchId,
        paymentReference,
        recipientReference,
        receiver,
        entry.receiver_masked,
        input.amountMinor,
        input.currency,
        paymentFingerprint({ batchReference, paymentReference, recipientReference, receiverType: 'EMAIL', receiver, amountMinor: input.amountMinor, currency: input.currency }),
        now,
      );
      db.prepare(
        `INSERT INTO provider_transactions (payment_item_id, mode, provider_item_id, provider_transaction_id, status, error_code, amount_minor, currency, status_updated_at, updated_at)
         VALUES (?, 'simulation', ?, NULL, 'RETURNED', NULL, ?, ?, ?, ?)`,
      ).run(itemId, `SIM-ITEM-${labels.referencePrefix}-${n}`, input.amountMinor, input.currency, returnedAt, now);

      insertPaymentEvent(db, {
        organisationId: input.organisationId,
        batchId,
        paymentItemId: itemId,
        caseId: null,
        type: 'batch_submitted',
        source: 'simulation',
        occurredAt: submittedAt,
        summary: `Simulated original payment ${paymentReference} for the ${labels.context}. ${SIMULATED_NOTE}`,
      });
      insertPaymentEvent(db, {
        organisationId: input.organisationId,
        batchId,
        paymentItemId: itemId,
        caseId: null,
        type: 'provider_status_changed',
        source: 'simulation',
        occurredAt: returnedAt,
        previousStatus: 'UNCLAIMED',
        newStatus: 'RETURNED',
        summary: `Simulated provider record: RETURNED. This status is simulated, not reported by PayPal. ${SIMULATED_NOTE}`,
      });

      const caseId = `case_${randomUUID()}`;
      const caseReference = nextCaseReference(db, input.organisationId);
      const reason = `Simulated provider record shows ${paymentReference} as RETURNED. ${labels.context}: ${SIMULATED_NOTE}`;
      db.prepare(
        `INSERT INTO payment_cases (id, organisation_id, reference, payment_item_id, state, basis, opening_reason, opened_at, updated_at, version)
         VALUES (?, ?, ?, ?, 'open', 'provider_confirmed', ?, ?, ?, 1)`,
      ).run(caseId, input.organisationId, caseReference, itemId, reason, now, now);
      insertPaymentEvent(db, {
        organisationId: input.organisationId,
        batchId,
        paymentItemId: itemId,
        caseId,
        type: 'case_opened',
        source: 'system',
        occurredAt: now,
        newCaseState: 'open',
        summary: `Case ${caseReference} opened for the ${labels.context}. ${SIMULATED_NOTE}`,
      });
      appendAudit(db, {
        organisationId: input.organisationId,
        actor: { type: 'system' },
        action: labels.auditAction,
        entityType: 'payment_case',
        entityId: caseId,
        outcome: 'succeeded',
        newState: { caseReference, paymentReference, batchReference, amountMinor: input.amountMinor, currency: input.currency, receiverMasked: entry.receiver_masked },
        reason: `${labels.auditReason} ${SIMULATED_NOTE}`,
      });
      return { caseId, caseReference, paymentReference, batchReference };
    })
    .immediate();
}
