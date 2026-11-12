import { writeFileSync, mkdtempSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDatabase, insertBaseRecords, type TempDatabase } from '../test-support/tempDb';
import { loadMigrations, MIGRATIONS_DIR, runMigrations } from './migrate';

let temp: TempDatabase;
beforeEach(() => {
  temp = createTempDatabase();
  insertBaseRecords(temp.db);
});
afterEach(() => temp.cleanup());

function insertBatch(id = 'bat_1', reference = 'B-1') {
  temp.db
    .prepare(
      `INSERT INTO payment_batches (id, organisation_id, reference, kind, origin, programme, provider_mode, created_by_user_id)
       VALUES (?, 'org_t', ?, 'disbursement', 'provider_submission', 'Programme', 'simulation', 'usr_op')`,
    )
    .run(id, reference);
}

function insertItem(overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'itm_1',
    batch_id: 'bat_1',
    payment_reference: 'REF-1',
    recipient_reference: 'BEN-001',
    receiver_type: 'EMAIL',
    receiver_value: 'a.ben-001.1@example.org',
    receiver_masked: 'a•••1@example.org',
    amount_minor: 10000,
    currency: 'USD',
    fingerprint: 'f'.repeat(64),
    ...overrides,
  };
  temp.db
    .prepare(
      `INSERT INTO payment_items (id, organisation_id, batch_id, payment_reference, recipient_reference, receiver_type,
         receiver_value, receiver_masked, amount_minor, currency, fingerprint)
       VALUES (@id, 'org_t', @batch_id, @payment_reference, @recipient_reference, @receiver_type,
         @receiver_value, @receiver_masked, @amount_minor, @currency, @fingerprint)`,
    )
    .run(row);
}

function insertCase(id: string, state = 'open') {
  temp.db
    .prepare(
      `INSERT INTO payment_cases (id, organisation_id, reference, payment_item_id, state, basis, opening_reason, opened_at, updated_at)
       VALUES (?, 'org_t', ?, 'itm_1', ?, 'provider_confirmed', 'provider_exception', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
    )
    .run(id, `RC-${id}`, state);
}

describe('connection settings', () => {
  it('enables WAL, foreign keys, a busy timeout and full synchronous writes', () => {
    expect(temp.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(temp.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(temp.db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(temp.db.pragma('synchronous', { simple: true })).toBe(2);
  });
});

describe('migrations', () => {
  it('applies every migration once and records its checksum', () => {
    const rows = temp.db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
    expect(rows).toEqual(loadMigrations().map((m) => ({ version: m.version, name: m.name, checksum: m.checksum })));
    expect(runMigrations(temp.db)).toEqual([]);
  });

  it('refuses to run when an applied migration has been edited', () => {
    const edited = loadMigrations().map((m, i) => (i === 0 ? { ...m, checksum: 'e'.repeat(64) } : m));
    expect(() => runMigrations(temp.db, edited)).toThrow(/was edited after it was applied/);
  });

  it('refuses to run against a database migrated by newer code', () => {
    expect(() => runMigrations(temp.db, loadMigrations().slice(0, 2))).toThrow(/does not know/);
  });

  it('rolls back a failing migration completely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reliefrelay-migrations-'));
    try {
      for (const file of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
      const next = String(loadMigrations().length + 1).padStart(4, '0');
      writeFileSync(join(dir, `${next}_broken.sql`), 'CREATE TABLE half_done (id INTEGER) STRICT;\nTHIS IS NOT SQL;');
      expect(() => runMigrations(temp.db, loadMigrations(dir))).toThrow();
      expect(temp.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'half_done'").get()).toEqual({ n: 0 });
      expect(temp.db.prepare('SELECT max(version) AS v FROM schema_migrations').get()).toEqual({ v: loadMigrations().length });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('constraints', () => {
  beforeEach(() => insertBatch());

  it('enforces strict column types', () => {
    expect(() => insertItem({ amount_minor: 'one hundred' })).toThrow(/cannot store TEXT value in INTEGER column/);
    expect(() => insertItem({ amount_minor: 100.5 })).toThrow(/cannot store REAL value in INTEGER column/);
  });

  it('rejects non-positive amounts, unsupported currencies and receiver types', () => {
    expect(() => insertItem({ amount_minor: 0 })).toThrow(/CHECK constraint failed/);
    expect(() => insertItem({ amount_minor: -500 })).toThrow(/CHECK constraint failed/);
    expect(() => insertItem({ currency: 'JPY' })).toThrow(/CHECK constraint failed/);
    expect(() => insertItem({ receiver_type: 'PAYPAL_ID' })).toThrow(/CHECK constraint failed/);
  });

  it('rejects a duplicate payment reference within an organisation', () => {
    insertItem();
    expect(() => insertItem({ id: 'itm_2' })).toThrow(/UNIQUE constraint failed: payment_items.organisation_id, payment_items.payment_reference/);
  });

  it('enforces foreign keys', () => {
    expect(() => insertItem({ batch_id: 'bat_missing' })).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('rejects provider statuses outside the PayPal vocabulary', () => {
    insertItem();
    expect(() =>
      temp.db
        .prepare(
          `INSERT INTO provider_transactions (payment_item_id, mode, status, amount_minor, currency, status_updated_at)
           VALUES ('itm_1', 'simulation', 'DELIVERED', 10000, 'USD', '2026-11-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('requires simulated provider references to carry the SIM- prefix', () => {
    insertItem();
    expect(() =>
      temp.db
        .prepare(
          `INSERT INTO provider_transactions (payment_item_id, mode, provider_item_id, status, amount_minor, currency, status_updated_at)
           VALUES ('itm_1', 'simulation', 'REALID123', 'SUCCESS', 10000, 'USD', '2026-11-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('allows only one active case per payment', () => {
    insertItem();
    insertCase('c1');
    expect(() => insertCase('c2')).toThrow(/UNIQUE constraint failed/);
  });
});

describe('immutability triggers', () => {
  beforeEach(() => {
    insertBatch();
    insertItem();
  });

  it('never allows financial details of a payment to change', () => {
    expect(() => temp.db.prepare('UPDATE payment_items SET amount_minor = 99999').run()).toThrow(/immutable/);
    expect(() => temp.db.prepare("UPDATE payment_items SET receiver_value = 'x@example.org'").run()).toThrow(/immutable/);
    expect(() => temp.db.prepare('DELETE FROM payment_items').run()).toThrow(/cannot be deleted/);
  });

  it('requires case updates to increment the version by exactly one', () => {
    insertCase('c1');
    expect(() => temp.db.prepare("UPDATE payment_cases SET state = 'investigating' WHERE id = 'c1'").run()).toThrow(/increment version/);
    expect(() => temp.db.prepare("UPDATE payment_cases SET state = 'investigating', version = 3 WHERE id = 'c1'").run()).toThrow(
      /increment version/,
    );
    temp.db.prepare("UPDATE payment_cases SET state = 'investigating', version = 2 WHERE id = 'c1'").run();
    expect(() => temp.db.prepare("UPDATE payment_cases SET basis = 'imported_record', version = 3 WHERE id = 'c1'").run()).toThrow(
      /cannot be changed/,
    );
  });

  it.each([
    ['case_notes', "INSERT INTO case_notes (id, case_id, author_user_id, body) VALUES ('n1', 'c1', 'usr_op', 'Checked with programme team.')"],
    [
      'payment_events',
      "INSERT INTO payment_events (id, organisation_id, batch_id, type, source, occurred_at, summary) VALUES ('e1', 'org_t', 'bat_1', 'batch_imported', 'operator', '2026-11-01T00:00:00.000Z', 'Imported')",
    ],
    [
      'reconciliation_findings',
      "INSERT INTO reconciliation_findings (id, organisation_id, payment_item_id, code, severity, detail, rule_version) VALUES ('f1', 'org_t', 'itm_1', 'possible_duplicate_payment', 'warning', 'Same recipient and amount', 1)",
    ],
  ])('keeps %s append-only', (table, insert) => {
    insertCase('c1');
    temp.db.prepare(insert).run();
    expect(() => temp.db.prepare(`UPDATE ${table} SET rowid = rowid`).run()).toThrow(/append-only/);
    expect(() => temp.db.prepare(`DELETE FROM ${table}`).run()).toThrow(/append-only/);
  });
});
