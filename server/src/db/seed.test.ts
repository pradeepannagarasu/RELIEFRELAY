import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOverview } from '@shared/domain/overview';
import { verifyAuditChain } from '../audit/auditLog';
import { loadDataset } from '../repositories/sqlite/readModel';
import { createSyntheticDataset } from '../seed/syntheticDataset';
import { createTempDatabase, type TempDatabase } from '../test-support/tempDb';
import { isDatabaseEmpty, seedDatabase } from './seed';

const NOW = new Date('2026-11-10T12:00:00.000Z');
let temp: TempDatabase;
beforeEach(() => {
  temp = createTempDatabase();
});
afterEach(() => temp.cleanup());

const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));

describe('database seed', () => {
  it('stores the synthetic dataset losslessly', () => {
    const dataset = createSyntheticDataset(NOW);
    seedDatabase(temp.db, dataset);
    const loaded = loadDataset(temp.db, dataset.organisation.id)!;
    expect(loaded.organisation).toEqual(dataset.organisation);
    expect(byId(loaded.users)).toEqual(byId(dataset.users));
    expect(byId(loaded.batches)).toEqual(byId(dataset.batches));
    expect(byId(loaded.items)).toEqual(byId(dataset.items));
    expect(byId(loaded.cases)).toEqual(byId(dataset.cases));
    expect(byId(loaded.events)).toEqual(byId(dataset.events));
  });

  it('keeps the Phase 1 overview figures unchanged when served from SQLite', () => {
    seedDatabase(temp.db, createSyntheticDataset(NOW));
    const overview = buildOverview(loadDataset(temp.db, 'org_demo')!, NOW);
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

  it('records seeding in the audit log and refuses to seed twice', () => {
    expect(isDatabaseEmpty(temp.db)).toBe(true);
    seedDatabase(temp.db, createSyntheticDataset(NOW));
    expect(() => seedDatabase(temp.db, createSyntheticDataset(NOW))).toThrow(/already contains data/);
    const audit = verifyAuditChain(temp.db);
    expect(audit).toMatchObject({ ok: true, eventCount: 1 });
    expect(temp.db.prepare('SELECT action, actor_type FROM audit_events').get()).toEqual({ action: 'demo_data.seeded', actor_type: 'system' });
  });

  it('only stores receivers on reserved test domains', () => {
    seedDatabase(temp.db, createSyntheticDataset(NOW));
    const receivers = temp.db.prepare('SELECT receiver_value FROM payment_items').all() as { receiver_value: string }[];
    for (const { receiver_value } of receivers) expect(receiver_value).toMatch(/@example\.org$/);
  });
});
