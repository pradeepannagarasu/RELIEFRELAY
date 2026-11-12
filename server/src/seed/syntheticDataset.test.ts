import { describe, expect, it } from 'vitest';
import { buildOverview } from '@shared/domain/overview';
import { UNCLAIMED_AUTO_RETURN_DAYS } from '@shared/domain/paypal';
import { createSyntheticDataset, syntheticReceiverFor } from './syntheticDataset';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const DAY = 86_400_000;

describe('synthetic dataset', () => {
  const data = createSyntheticDataset(NOW);
  const itemsById = new Map(data.items.map((i) => [i.id, i]));

  it('is deterministic for a given clock', () => {
    expect(createSyntheticDataset(NOW)).toEqual(data);
  });

  it('marks every provider reference as simulated and every batch as simulation mode', () => {
    expect(data.organisation.isSynthetic).toBe(true);
    for (const batch of data.batches) {
      expect(batch.providerMode).toBe('simulation');
      expect(batch.providerBatchId).toMatch(/^SIM-/);
    }
    for (const item of data.items) {
      expect(item.provider?.mode).toBe('simulation');
      expect(item.provider?.providerItemId).toMatch(/^SIM-/);
      if (item.provider?.providerTransactionId) expect(item.provider.providerTransactionId).toMatch(/^SIM-/);
      expect(item.recipientMasked).toMatch(/@example\.org$/);
      expect(syntheticReceiverFor(item)).toMatch(/@example\.org$/);
    }
  });

  it('uses unique sender item ids, the provider-side idempotency key', () => {
    const ids = data.items.map((i) => i.senderItemId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only shows RETURNED after the unclaimed period and UNCLAIMED within it', () => {
    for (const item of data.items) {
      const provider = item.provider!;
      const ageDays = (NOW.getTime() - Date.parse(provider.statusUpdatedAt)) / DAY;
      if (provider.status === 'UNCLAIMED') expect(ageDays).toBeLessThan(UNCLAIMED_AUTO_RETURN_DAYS);
      if (provider.status === 'RETURNED') {
        const unclaimed = data.events.find((e) => e.paymentItemId === item.id && e.newStatus === 'UNCLAIMED');
        expect(unclaimed).toBeDefined();
        const gapDays = (Date.parse(provider.statusUpdatedAt) - Date.parse(unclaimed!.occurredAt)) / DAY;
        expect(gapDays).toBeCloseTo(UNCLAIMED_AUTO_RETURN_DAYS, 5);
      }
    }
  });

  it('opens exactly one case for every undelivered, non-pending original payment', () => {
    const exceptional = data.items.filter(
      (i) => i.recoveryOfItemId === null && !['SUCCESS', 'PENDING'].includes(i.provider?.status ?? ''),
    );
    expect(data.cases.map((c) => c.paymentItemId).sort()).toEqual(exceptional.map((i) => i.id).sort());
  });

  it('backs every resolved case with a delivered recovery payment of the same amount', () => {
    for (const c of data.cases.filter((c) => c.state === 'resolved')) {
      const recovery = itemsById.get(c.resolution?.recoveryItemId ?? '');
      const original = itemsById.get(c.paymentItemId);
      expect(recovery?.provider?.status).toBe('SUCCESS');
      expect(recovery?.recoveryOfItemId).toBe(c.paymentItemId);
      expect(recovery?.amount).toEqual(original?.amount);
    }
  });

  it('never records events in the future', () => {
    for (const event of data.events) expect(Date.parse(event.occurredAt)).toBeLessThanOrEqual(NOW.getTime());
  });

  it('produces a coherent overview', () => {
    const overview = buildOverview(data, NOW);
    expect(overview.payments.count).toBe(118);
    expect(Object.fromEntries(overview.outcomes.map((o) => [o.outcome, o.count]))).toEqual({
      delivered: 94,
      recovered: 2,
      in_progress: 7,
      requires_action: 14,
      unconfirmed: 0,
      closed_undelivered: 1,
    });
    expect(overview.attention[0]).toMatchObject({ kind: 'unclaimed_return_imminent', count: 4 });
  });
});
