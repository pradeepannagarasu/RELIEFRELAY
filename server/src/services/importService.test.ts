import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../audit/auditLog';
import { AppError } from '../lib/errors';
import { loadDataset } from '../repositories/sqlite/readModel';
import { contextFor, createSeededDatabase, TEST_NOW } from '../test-support/seededApp';
import type { TempDatabase } from '../test-support/tempDb';
import { createImportService } from './importService';

const HEADER = 'payment_reference,batch_reference,recipient_reference,amount,currency,receiver_type,receiver,status,status_date,error_code';
const line = (ref: string, { amount = '90.00', status = 'SUCCESS', date = '2026-11-05', error = '' } = {}) =>
  `${ref},RR-B-2026-077,BEN-${ref.slice(-4)},${amount},USD,EMAIL,ben-${ref.slice(-4).toLowerCase()}@example.org,${status},${date},${error}`;
const file = (...lines: string[]) => new TextEncoder().encode([HEADER, ...lines].join('\n'));

let temp: TempDatabase | undefined;
afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

function setup(options: Parameters<typeof createSeededDatabase>[0] = {}) {
  temp = createSeededDatabase(options);
  const service = createImportService(temp.db, () => TEST_NOW);
  const ctx = contextFor(temp);
  const prepare = async (name: string, bytes: Uint8Array) => {
    const { import: created } = await service.upload(ctx, name, bytes);
    return service.applyMapping(ctx, created.id, created.suggestedMapping);
  };
  const importFile = async (name: string, bytes: Uint8Array) => {
    const validated = await prepare(name, bytes);
    return service.commit(ctx, validated.id, { validationVersion: validated.validationVersion });
  };
  return { temp, service, ctx, prepare, importFile };
}

const count = (t: TempDatabase, table: string) => (t.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('import service', () => {
  it('keeps every status observation with its provenance and never overwrites earlier ones', async () => {
    const { temp, ctx, importFile } = setup();
    const first = await importFile('day-1.csv', file(line('RR-T-OBS-0001', { status: 'PENDING', date: '2026-11-03' })));
    const second = await importFile('day-2.csv', file(line('RR-T-OBS-0001', { status: 'UNCLAIMED', date: '2026-11-06' })));
    expect(second.import.result).toMatchObject({ newPayments: 0, statusObservations: 1 });

    const observations = temp.db
      .prepare("SELECT o.status, o.status_at, o.import_id, o.row_number, o.recorded_at FROM status_observations o JOIN payment_items i ON i.id = o.payment_item_id WHERE i.payment_reference = 'RR-T-OBS-0001' ORDER BY o.seq")
      .all() as { status: string; status_at: string; import_id: string; row_number: number; recorded_at: string }[];
    expect(observations).toHaveLength(2);
    expect(observations.map((o) => [o.status, o.import_id, o.row_number])).toEqual([
      ['PENDING', first.import.id, 2],
      ['UNCLAIMED', second.import.id, 2],
    ]);
    expect(observations.every((o) => o.recorded_at.endsWith('Z'))).toBe(true);

    const item = loadDataset(temp.db, ctx.actor.organisationId)?.items.find((i) => i.senderItemId === 'RR-T-OBS-0001');
    expect(item?.imported?.status).toBe('UNCLAIMED');
    expect(item?.provider).toBeNull();

    const findings = temp.db.prepare("SELECT code FROM reconciliation_findings WHERE import_id = ?").all(second.import.id) as { code: string }[];
    expect(findings.map((f) => f.code)).toEqual(expect.arrayContaining(['imported_status_changed', 'exception_status_recorded']));
  });

  it('records an imported status without touching the provider-confirmed status', async () => {
    const { temp, service, ctx, importFile } = setup();
    const seeded = temp.db
      .prepare(
        `SELECT i.id, i.payment_reference, b.reference AS batch, i.recipient_reference, i.receiver_value, i.amount_minor, p.status, p.status_updated_at
         FROM payment_items i JOIN payment_batches b ON b.id = i.batch_id JOIN provider_transactions p ON p.payment_item_id = i.id
         WHERE p.status = 'SUCCESS' AND i.currency = 'USD' AND i.receiver_type = 'EMAIL' LIMIT 1`,
      )
      .get() as { id: string; payment_reference: string; batch: string; recipient_reference: string; receiver_value: string; amount_minor: number; status: string; status_updated_at: string };
    const amount = `${Math.floor(seeded.amount_minor / 100)}.${String(seeded.amount_minor % 100).padStart(2, '0')}`;
    const row = `${seeded.payment_reference},${seeded.batch},${seeded.recipient_reference},${amount},USD,EMAIL,${seeded.receiver_value},RETURNED,2026-11-08,`;
    const result = await importFile('returned.csv', file(row));
    expect(result.import.result?.casesOpened).toHaveLength(1);

    const provider = temp.db.prepare('SELECT status, status_updated_at FROM provider_transactions WHERE payment_item_id = ?').get(seeded.id);
    expect(provider).toEqual({ status: 'SUCCESS', status_updated_at: seeded.status_updated_at });
    const caseRow = temp.db.prepare('SELECT basis, opening_reason FROM payment_cases WHERE payment_item_id = ?').get(seeded.id);
    expect(caseRow).toEqual({ basis: 'reconciliation_conflict', opening_reason: 'provider_status_conflict' });

    const again = await service.upload(ctx, 'returned-again.csv', file(row, ''));
    const validated = await service.applyMapping(ctx, again.import.id, again.import.suggestedMapping);
    expect(validated.summary?.outcomes).toMatchObject({ unchanged: 1, status_update: 0, new_payment: 0 });
  });

  it('rejects a reused payment reference with different details and opens a conflict case on the original', async () => {
    const { temp, importFile } = setup();
    await importFile('original.csv', file(line('RR-T-CON-0001')));
    const result = await importFile('changed.csv', file(line('RR-T-CON-0001', { amount: '95.00' })));
    expect(result.import.result).toMatchObject({ newPayments: 0, rejected: 1, findingsRecorded: 1 });
    expect(result.import.result?.casesOpened).toHaveLength(1);
    const amounts = temp.db.prepare("SELECT amount_minor FROM payment_items WHERE payment_reference = 'RR-T-CON-0001'").all();
    expect(amounts).toEqual([{ amount_minor: 9000 }]);
  });

  it('flags possible duplicates without merging, deleting or rejecting them', async () => {
    const { temp, importFile } = setup();
    const dup = (ref: string) => `${ref},RR-B-2026-078,BEN-SAME01,60.00,USD,EMAIL,ben-same01@example.org,SUCCESS,2026-11-05,`;
    const result = await importFile('dups.csv', file(dup('RR-T-DUP-0001'), dup('RR-T-DUP-0002')));
    expect(result.import.result).toMatchObject({ newPayments: 2 });
    expect(result.import.result?.casesOpened).toHaveLength(1);
    expect(count(temp, "payment_items WHERE recipient_reference = 'BEN-SAME01'")).toBe(2);
    const reason = temp.db
      .prepare("SELECT c.opening_reason FROM payment_cases c JOIN payment_items i ON i.id = c.payment_item_id WHERE i.payment_reference = 'RR-T-DUP-0002'")
      .get();
    expect(reason).toEqual({ opening_reason: 'possible_duplicate_payment' });
  });

  it('rolls back the whole commit when any write fails', async () => {
    const { temp, service, ctx, prepare } = setup();
    const validated = await prepare('rollback.csv', file(line('RR-T-RB-0001'), line('RR-T-RB-0002', { status: 'FAILED', error: 'RECEIVER_ACCOUNT_LOCKED' })));
    const before = { items: count(temp, 'payment_items'), audit: count(temp, 'audit_events'), events: count(temp, 'payment_events') };
    temp.db.exec(
      "CREATE TEMP TRIGGER fail_cases BEFORE INSERT ON payment_cases BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    await expect(service.commit(ctx, validated.id, { validationVersion: validated.validationVersion })).rejects.toThrow(/injected failure/);
    expect({ items: count(temp, 'payment_items'), audit: count(temp, 'audit_events'), events: count(temp, 'payment_events') }).toEqual(before);
    expect((await service.get(ctx, validated.id)).status).toBe('validated');

    temp.db.exec('DROP TRIGGER fail_cases');
    const committed = await service.commit(ctx, validated.id, { validationVersion: validated.validationVersion });
    expect(committed.import.result).toMatchObject({ newPayments: 2 });
    expect(verifyAuditChain(temp.db).ok).toBe(true);
  });

  it('reports a busy database clearly instead of waiting forever', async () => {
    const { temp, prepare } = setup();
    const validated = await prepare('busy.csv', file(line('RR-T-BUSY-0001')));
    const fast = temp.connect({ busyTimeoutMs: 50 });
    const service = createImportService(fast, () => TEST_NOW);
    const ctx = contextFor(temp);
    temp.db.prepare('BEGIN IMMEDIATE').run();
    try {
      const error = await service.commit(ctx, validated.id, { validationVersion: validated.validationVersion }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('service_unavailable');
    } finally {
      temp.db.prepare('ROLLBACK').run();
    }
    expect((await service.commit(ctx, validated.id, { validationVersion: validated.validationVersion })).alreadyCommitted).toBe(false);
  });

  it('commits exactly once when two processes race to commit the same import', async () => {
    const { temp, prepare } = setup();
    const validated = await prepare('race.csv', file(line('RR-T-RACE-0001'), line('RR-T-RACE-0002', { status: 'UNCLAIMED' })));
    const tsx = resolve('node_modules/tsx/dist/cli.mjs');
    const worker = resolve('server/src/test-support/commitWorker.ts');
    const startAt = String(Date.now() + 1500);
    const run = () =>
      new Promise<{ ok: boolean; alreadyCommitted?: boolean; error?: string }>((done, fail) => {
        const child = spawn(process.execPath, [tsx, '--tsconfig', 'server/tsconfig.json', worker, temp.path, validated.id, String(validated.validationVersion), startAt], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
        child.on('error', fail);
        child.on('close', (code) => (code === 0 && out ? done(JSON.parse(out)) : fail(new Error(`worker exited ${code}: ${err}`))));
      });

    const results = await Promise.all([run(), run()]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.alreadyCommitted).sort()).toEqual([false, true]);
    expect(count(temp, "payment_items WHERE payment_reference LIKE 'RR-T-RACE-%'")).toBe(2);
    expect(count(temp, "payment_cases c JOIN payment_items i ON i.id = c.payment_item_id WHERE i.payment_reference = 'RR-T-RACE-0002'")).toBe(1);
    expect(count(temp, "audit_events WHERE action = 'import.committed'")).toBe(1);
    expect(verifyAuditChain(temp.db).ok).toBe(true);
  }, 30_000);
});
