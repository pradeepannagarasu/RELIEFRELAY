import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDatabase, insertBaseRecords, type TempDatabase } from '../test-support/tempDb';
import { appendAudit, verifyAuditChain, type AuditEntry } from './auditLog';

let temp: TempDatabase;
beforeEach(() => {
  temp = createTempDatabase();
  insertBaseRecords(temp.db);
});
afterEach(() => temp.cleanup());

const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  organisationId: 'org_t',
  actor: { type: 'user', userId: 'usr_op', role: 'operator' },
  action: 'case.note_added',
  entityType: 'payment_case',
  entityId: 'case_1',
  outcome: 'succeeded',
  newState: { noteId: 'n1' },
  ...overrides,
});

/** Simulates a database administrator with file access: drops the protective triggers. */
function dropProtection() {
  for (const trigger of ['audit_events_no_update', 'audit_events_no_delete', 'audit_chain_no_update', 'audit_chain_no_delete']) {
    temp.db.exec(`DROP TRIGGER ${trigger}`);
  }
}

describe('audit log', () => {
  it('assigns consecutive sequence numbers and database timestamps', () => {
    const seqs = [appendAudit(temp.db, entry()), appendAudit(temp.db, entry()), appendAudit(temp.db, entry())];
    expect(seqs).toEqual([1, 2, 3]);
    const rows = temp.db.prepare('SELECT recorded_at FROM audit_events').all() as { recorded_at: string }[];
    for (const row of rows) expect(Math.abs(Date.parse(row.recorded_at) - Date.now())).toBeLessThan(10_000);
  });

  it('rejects application-supplied timestamps, so events cannot be backdated', () => {
    expect(() =>
      temp.db
        .prepare(
          "INSERT INTO audit_events (recorded_at, organisation_id, actor_type, action, entity_type, outcome) VALUES ('2020-01-01T00:00:00.000Z', 'org_t', 'system', 'test.backdated', 'x', 'succeeded')",
        )
        .run(),
    ).toThrow(/assigned by the database clock/);
  });

  it('rejects updates and deletes', () => {
    appendAudit(temp.db, entry());
    expect(() => temp.db.prepare("UPDATE audit_events SET action = 'case.hidden'").run()).toThrow(/append-only/);
    expect(() => temp.db.prepare('DELETE FROM audit_events').run()).toThrow(/append-only/);
    expect(() => temp.db.prepare("UPDATE audit_chain SET hash = '0'").run()).toThrow(/append-only/);
    expect(() => temp.db.prepare('DELETE FROM audit_chain').run()).toThrow(/append-only/);
  });

  it('rejects an explicit sequence number that would leave a gap', () => {
    appendAudit(temp.db, entry());
    expect(() =>
      temp.db
        .prepare("INSERT INTO audit_events (seq, organisation_id, actor_type, action, entity_type, outcome) VALUES (7, 'org_t', 'system', 'test.gap', 'x', 'succeeded')")
        .run(),
    ).toThrow(/exactly one consecutive event/);
    expect(verifyAuditChain(temp.db).eventCount).toBe(1);
  });

  it('rejects forged chain rows', () => {
    dropProtection();
    appendAudit(temp.db, entry());
    temp.db.exec('DROP TRIGGER audit_events_extend_chain');
    temp.db.prepare("INSERT INTO audit_events (organisation_id, actor_type, action, entity_type, outcome) VALUES ('org_t', 'system', 'test.forged', 'x', 'succeeded')").run();
    const head = temp.db.prepare('SELECT hash FROM audit_chain WHERE seq = 1').get() as { hash: string };
    expect(() => temp.db.prepare('INSERT INTO audit_chain (seq, prev_hash, hash) VALUES (2, ?, ?)').run(head.hash, 'a'.repeat(64))).toThrow(
      /does not match the event content/,
    );
  });

  it('rolls the audit event back with a failed transaction', () => {
    expect(() =>
      temp.db.transaction(() => {
        appendAudit(temp.db, entry());
        throw new Error('change failed');
      })(),
    ).toThrow('change failed');
    expect(verifyAuditChain(temp.db)).toMatchObject({ ok: true, eventCount: 0 });
    expect(appendAudit(temp.db, entry())).toBe(1);
  });

  it('produces hashes that independent recalculation in application code agrees with', () => {
    appendAudit(temp.db, entry({ reason: 'Quotes " backslash \\ newline \n tab \t unicode • é 😀 control \u0001' }));
    appendAudit(temp.db, entry({ actor: { type: 'system' }, previousState: { a: [1, null, 'x'] }, entityId: null }));
    appendAudit(temp.db, entry({ outcome: 'rejected', requestId: 'req-12345678' }));
    expect(verifyAuditChain(temp.db)).toMatchObject({ ok: true, eventCount: 3, problems: [] });
  });

  describe('tamper evidence (not tamper-proofing)', () => {
    beforeEach(() => {
      for (let i = 0; i < 5; i += 1) appendAudit(temp.db, entry({ entityId: `case_${i}` }));
      dropProtection();
    });

    it('detects an edited event at the right sequence number', () => {
      temp.db.prepare("UPDATE audit_events SET outcome = 'rejected' WHERE seq = 3").run();
      const result = verifyAuditChain(temp.db);
      expect(result.ok).toBe(false);
      expect(result.problems[0]).toMatchObject({ seq: 3, kind: 'hash_mismatch' });
    });

    it('detects a deleted event in the middle of the history', () => {
      temp.db.prepare('DELETE FROM audit_chain WHERE seq = 2').run();
      temp.db.prepare('DELETE FROM audit_events WHERE seq = 2').run();
      const kinds = verifyAuditChain(temp.db).problems.map((p) => [p.seq, p.kind]);
      expect(kinds).toContainEqual([3, 'sequence_gap']);
      expect(kinds).toContainEqual([3, 'prev_hash_mismatch']);
    });

    it('cannot detect deletion of the newest events without an external anchor, but can with one', () => {
      const anchor = verifyAuditChain(temp.db).head!;
      temp.db.prepare('DELETE FROM audit_chain WHERE seq >= 4').run();
      temp.db.prepare('DELETE FROM audit_events WHERE seq >= 4').run();
      expect(verifyAuditChain(temp.db).ok).toBe(true);
      expect(verifyAuditChain(temp.db, anchor).problems).toEqual([expect.objectContaining({ seq: 5, kind: 'anchor_mismatch' })]);
    });

    it('cannot detect a fully recomputed chain, which is why the log is described as tamper-evident only', () => {
      const anchor = verifyAuditChain(temp.db).head!;
      temp.db.prepare("UPDATE audit_events SET outcome = 'rejected' WHERE seq = 2").run();
      const rows = temp.db.prepare('SELECT seq FROM audit_events ORDER BY seq').all() as { seq: number }[];
      temp.db.prepare('DELETE FROM audit_chain').run();
      temp.db.exec('DROP TRIGGER audit_chain_verify_insert');
      for (const { seq } of rows) {
        temp.db
          .prepare(
            `INSERT INTO audit_chain (seq, prev_hash, hash)
             SELECT e.seq, (SELECT hash FROM audit_chain WHERE seq = e.seq - 1),
               rr_sha256(coalesce((SELECT hash FROM audit_chain WHERE seq = e.seq - 1), 'GENESIS') || char(10) || json_array(
                 e.seq, e.recorded_at, e.organisation_id, e.actor_type, e.actor_user_id, e.actor_role, e.action, e.entity_type,
                 e.entity_id, e.outcome, e.request_id, e.previous_state, e.new_state, e.reason))
             FROM audit_events e WHERE e.seq = ?`,
          )
          .run(seq);
      }
      expect(verifyAuditChain(temp.db).ok).toBe(true);
      expect(verifyAuditChain(temp.db, anchor).ok).toBe(false);
    });
  });
});
