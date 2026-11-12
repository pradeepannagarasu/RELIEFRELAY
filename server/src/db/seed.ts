import type { PaymentDataset } from '@shared/domain/types';
import { appendAudit } from '../audit/auditLog';
import { paymentFingerprint } from '../lib/paymentIdentity';
import { syntheticReceiverFor } from '../seed/syntheticDataset';
import type { Db } from './connection';

export class SeedError extends Error {
  override name = 'SeedError';
}

export function isDatabaseEmpty(db: Db): boolean {
  return (db.prepare('SELECT count(*) AS n FROM organisations').get() as { n: number }).n === 0;
}

/**
 * Writes the synthetic demonstration dataset into an empty database in one transaction.
 * Historical timestamps come from the dataset; the single audit event records when seeding happened.
 */
export function seedDatabase(db: Db, dataset: PaymentDataset): void {
  if (!dataset.organisation.isSynthetic) throw new SeedError('Only synthetic datasets can be seeded.');

  db.transaction(() => {
    if (!isDatabaseEmpty(db)) throw new SeedError('The database already contains data. Use npm run db:reset to start again.');
    const org = dataset.organisation;
    db.prepare('INSERT INTO organisations (id, name, is_synthetic) VALUES (?, ?, 1)').run(org.id, org.name);

    const insertUser = db.prepare('INSERT INTO users (id, organisation_id, display_name, email, role) VALUES (?, ?, ?, ?, ?)');
    for (const u of dataset.users) insertUser.run(u.id, u.organisationId, u.displayName, u.email, u.role);

    const insertBatch = db.prepare(
      `INSERT INTO payment_batches (id, organisation_id, reference, kind, origin, programme, sender_batch_id, provider_mode,
         provider_batch_id, provider_status, submitted_at, created_by_user_id, created_at)
       VALUES (@id, @organisationId, @reference, @kind, @origin, @programme, @senderBatchId, @providerMode,
         @providerBatchId, @status, @submittedAt, @importedByUserId, @importedAt)`,
    );
    for (const b of dataset.batches) insertBatch.run(b);

    const batchesById = new Map(dataset.batches.map((b) => [b.id, b]));
    const insertItem = db.prepare(
      `INSERT INTO payment_items (id, organisation_id, batch_id, payment_reference, recipient_reference, receiver_type,
         receiver_value, receiver_masked, amount_minor, currency, fingerprint, recovery_of_item_id, created_at)
       VALUES (@id, @organisationId, @batchId, @paymentReference, @recipientReference, @receiverType,
         @receiverValue, @receiverMasked, @amountMinor, @currency, @fingerprint, @recoveryOfItemId, @createdAt)`,
    );
    const insertProvider = db.prepare(
      `INSERT INTO provider_transactions (payment_item_id, mode, provider_item_id, provider_transaction_id, status, error_code,
         amount_minor, currency, status_updated_at, updated_at)
       VALUES (@itemId, @mode, @providerItemId, @providerTransactionId, @status, @errorCode, @amountMinor, @currency,
         @statusUpdatedAt, @statusUpdatedAt)`,
    );
    for (const item of dataset.items) {
      const batch = batchesById.get(item.batchId);
      if (!batch) throw new SeedError(`Item ${item.id} refers to a missing batch.`);
      const receiver = syntheticReceiverFor(item);
      insertItem.run({
        id: item.id,
        organisationId: org.id,
        batchId: item.batchId,
        paymentReference: item.senderItemId,
        recipientReference: item.recipientReference,
        receiverType: item.recipientType,
        receiverValue: receiver,
        receiverMasked: item.recipientMasked,
        amountMinor: item.amount.minor,
        currency: item.amount.currency,
        fingerprint: paymentFingerprint({
          batchReference: batch.reference,
          paymentReference: item.senderItemId,
          recipientReference: item.recipientReference,
          receiverType: item.recipientType,
          receiver,
          amountMinor: item.amount.minor,
          currency: item.amount.currency,
        }),
        recoveryOfItemId: item.recoveryOfItemId,
        createdAt: batch.importedAt,
      });
      if (item.provider) {
        insertProvider.run({
          itemId: item.id,
          ...item.provider,
          amountMinor: item.amount.minor,
          currency: item.amount.currency,
        });
      }
    }

    const insertCase = db.prepare(
      `INSERT INTO payment_cases (id, organisation_id, reference, payment_item_id, state, basis, opening_reason, assignee_user_id,
         opened_at, updated_at, version, resolution_kind, resolution_summary, resolved_at, resolved_by_user_id, recovery_item_id)
       VALUES (@id, @organisationId, @reference, @paymentItemId, @state, @basis, @openingReason, @assigneeUserId,
         @openedAt, @updatedAt, @version, @resolutionKind, @resolutionSummary, @resolvedAt, @resolvedByUserId, @recoveryItemId)`,
    );
    for (const c of dataset.cases) {
      insertCase.run({
        ...c,
        resolutionKind: c.resolution?.kind ?? null,
        resolutionSummary: c.resolution?.summary ?? null,
        resolvedAt: c.resolution?.resolvedAt ?? null,
        resolvedByUserId: c.resolution?.resolvedByUserId ?? null,
        recoveryItemId: c.resolution?.recoveryItemId ?? null,
      });
    }

    const insertEvent = db.prepare(
      `INSERT INTO payment_events (id, organisation_id, batch_id, payment_item_id, case_id, import_id, type, source, occurred_at,
         provider_event_type, previous_status, new_status, previous_case_state, new_case_state, actor_user_id, summary)
       VALUES (@id, @organisationId, @batchId, @paymentItemId, @caseId, @importId, @type, @source, @occurredAt,
         @providerEventType, @previousStatus, @newStatus, @previousCaseState, @newCaseState, @actorUserId, @summary)`,
    );
    for (const e of dataset.events) insertEvent.run(e);

    const highestCase = Math.max(0, ...dataset.cases.map((c) => Number(c.reference.replace(/^RC-/, ''))));
    db.prepare("INSERT INTO counters (organisation_id, name, value) VALUES (?, 'case_reference', ?)").run(org.id, highestCase);

    appendAudit(db, {
      organisationId: org.id,
      actor: { type: 'system' },
      action: 'demo_data.seeded',
      entityType: 'organisation',
      entityId: org.id,
      outcome: 'succeeded',
      newState: {
        synthetic: true,
        batches: dataset.batches.length,
        payments: dataset.items.length,
        cases: dataset.cases.length,
        events: dataset.events.length,
      },
      reason: 'Synthetic demonstration data loaded. Historical events carry their simulated timestamps; this audit entry records when they were loaded.',
    });
  }).immediate();
}
