import type { Role } from '@shared/domain/types';
import { sha256Hex, type Db } from '../db/connection';

export type AuditActor = { type: 'user'; userId: string; role: Role } | { type: 'system' };

export interface AuditEntry {
  organisationId: string;
  actor: AuditActor;
  /** Dotted action name, e.g. import.committed or case.note_added. */
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: 'succeeded' | 'rejected';
  requestId?: string | null;
  previousState?: unknown;
  newState?: unknown;
  reason?: string | null;
}

export interface AuditEventRow {
  seq: number;
  recorded_at: string;
  organisation_id: string;
  actor_type: 'user' | 'system';
  actor_user_id: string | null;
  actor_role: Role | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  outcome: 'succeeded' | 'rejected';
  request_id: string | null;
  previous_state: string | null;
  new_state: string | null;
  reason: string | null;
}

const json = (value: unknown) => (value === undefined || value === null ? null : JSON.stringify(value));

/**
 * Appends an audit event. Call it inside the same transaction as the change it records, so that the change
 * and its audit event are committed or rolled back together. The database assigns seq, recorded_at and the hash.
 */
export function appendAudit(db: Db, entry: AuditEntry): number {
  const result = db
    .prepare(
      `INSERT INTO audit_events (organisation_id, actor_type, actor_user_id, actor_role, action, entity_type, entity_id,
         outcome, request_id, previous_state, new_state, reason)
       VALUES (@organisationId, @actorType, @actorUserId, @actorRole, @action, @entityType, @entityId,
         @outcome, @requestId, @previousState, @newState, @reason)`,
    )
    .run({
      organisationId: entry.organisationId,
      actorType: entry.actor.type,
      actorUserId: entry.actor.type === 'user' ? entry.actor.userId : null,
      actorRole: entry.actor.type === 'user' ? entry.actor.role : null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      outcome: entry.outcome,
      requestId: entry.requestId ?? null,
      previousState: json(entry.previousState),
      newState: json(entry.newState),
      reason: entry.reason ?? null,
    });
  return Number(result.lastInsertRowid);
}

/**
 * Canonical content covered by each hash. Must match json_array(...) in migration 0004 exactly;
 * a test checks the two produce identical hashes, including for awkward characters.
 */
export function canonicalAuditContent(row: AuditEventRow): string {
  return JSON.stringify([
    row.seq,
    row.recorded_at,
    row.organisation_id,
    row.actor_type,
    row.actor_user_id,
    row.actor_role,
    row.action,
    row.entity_type,
    row.entity_id,
    row.outcome,
    row.request_id,
    row.previous_state,
    row.new_state,
    row.reason,
  ]);
}

export function computeAuditHash(prevHash: string | null, row: AuditEventRow): string {
  return sha256Hex(`${prevHash ?? 'GENESIS'}\n${canonicalAuditContent(row)}`);
}

export type AuditProblemKind = 'sequence_gap' | 'missing_chain_row' | 'orphan_chain_row' | 'prev_hash_mismatch' | 'hash_mismatch' | 'anchor_mismatch';

export interface AuditProblem {
  seq: number;
  kind: AuditProblemKind;
  detail: string;
}

export interface AuditChainHead {
  seq: number;
  hash: string;
}

export interface AuditVerification {
  ok: boolean;
  eventCount: number;
  head: AuditChainHead | null;
  problems: AuditProblem[];
}

/**
 * Recalculates every hash in application code, independently of the triggers that wrote them, and reports
 * where the chain breaks. Optionally compares against a chain head recorded outside the database, which is
 * the only way to detect deletion of the newest events.
 */
export function verifyAuditChain(db: Db, anchor?: AuditChainHead): AuditVerification {
  const events = db.prepare('SELECT * FROM audit_events ORDER BY seq').all() as AuditEventRow[];
  const chain = new Map(
    (db.prepare('SELECT seq, prev_hash, hash FROM audit_chain ORDER BY seq').all() as { seq: number; prev_hash: string | null; hash: string }[]).map(
      (row) => [row.seq, row],
    ),
  );
  const problems: AuditProblem[] = [];
  let expectedSeq = 1;
  let recomputedPrev: string | null = null;

  for (const event of events) {
    if (event.seq !== expectedSeq) {
      problems.push({ seq: event.seq, kind: 'sequence_gap', detail: `Expected event ${expectedSeq} but found ${event.seq}.` });
    }
    expectedSeq = event.seq + 1;

    const recomputed = computeAuditHash(recomputedPrev, event);
    const link = chain.get(event.seq);
    if (!link) {
      problems.push({ seq: event.seq, kind: 'missing_chain_row', detail: 'No hash was recorded for this event.' });
    } else {
      if (link.prev_hash !== recomputedPrev) {
        problems.push({ seq: event.seq, kind: 'prev_hash_mismatch', detail: 'The recorded previous hash does not match the preceding event.' });
      }
      if (link.hash !== recomputed) {
        problems.push({ seq: event.seq, kind: 'hash_mismatch', detail: 'The event content does not match its recorded hash.' });
      }
      chain.delete(event.seq);
    }
    recomputedPrev = recomputed;
  }
  for (const orphan of chain.values()) {
    problems.push({ seq: orphan.seq, kind: 'orphan_chain_row', detail: 'A hash exists for an event that is missing.' });
  }

  const last = events.at(-1);
  const head = last ? { seq: last.seq, hash: recomputedPrev ?? '' } : null;
  if (anchor) {
    const anchored = events.findIndex((e) => e.seq === anchor.seq);
    if (anchored === -1) {
      problems.push({ seq: anchor.seq, kind: 'anchor_mismatch', detail: 'The externally recorded chain head is missing: events may have been deleted.' });
    } else {
      let prev: string | null = null;
      let hashAtAnchor = '';
      for (const event of events.slice(0, anchored + 1)) {
        hashAtAnchor = computeAuditHash(prev, event);
        prev = hashAtAnchor;
      }
      if (hashAtAnchor !== anchor.hash) {
        problems.push({ seq: anchor.seq, kind: 'anchor_mismatch', detail: 'History up to the recorded chain head has been rewritten.' });
      }
    }
  }

  problems.sort((a, b) => a.seq - b.seq);
  return { ok: problems.length === 0, eventCount: events.length, head, problems };
}

export function listAuditEventsForEntity(db: Db, entityType: string, entityId: string): AuditEventRow[] {
  return db.prepare('SELECT * FROM audit_events WHERE entity_type = ? AND entity_id = ? ORDER BY seq').all(entityType, entityId) as AuditEventRow[];
}
