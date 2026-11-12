import { randomUUID } from 'node:crypto';
import type {
  AuditEntryView,
  CaseDetail,
  CaseListItem,
  CaseListResponse,
  CaseSortField,
  FindingView,
  NoteView,
  ObservationView,
  TimelineEvent,
} from '@shared/api/contracts';
import { deriveNextAction, isCaseActive, type NextActionCode } from '@shared/domain/cases';
import type { FindingCode, FindingSeverity } from '@shared/domain/findings';
import type { PayoutItemStatus } from '@shared/domain/paypal';
import { reportedStatus, type StatusSource } from '@shared/domain/status';
import type { CaseBasis, CaseState, PaymentCase, Role } from '@shared/domain/types';
import { appendAudit, listAuditEventsForEntity } from '../audit/auditLog';
import type { Db } from '../db/connection';
import { findContactDetails } from '../imports/privacy';
import { AppError } from '../lib/errors';
import {
  findUser,
  loadDataset,
  toBatch,
  toCase,
  toEvent,
  toImportedRecord,
  type BatchRow,
  type CaseRow,
  type EventRow,
  type ObservationRow,
} from '../repositories/sqlite/readModel';
import { assertRole, auditActor, auditRejection, rethrowBusy, type RequestContext } from './context';

export interface CaseListQuery {
  q?: string;
  status?: PayoutItemStatus;
  source?: StatusSource;
  /** A case state, 'active' (the default) or 'all'. */
  state?: CaseState | 'active' | 'all';
  nextAction?: NextActionCode;
  basis?: CaseBasis;
  batch?: string;
  assignee?: 'me' | 'unassigned';
  import?: string;
  sort: CaseSortField;
  order: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export interface CaseService {
  list(ctx: RequestContext, query: CaseListQuery): Promise<CaseListResponse>;
  get(ctx: RequestContext, caseId: string): Promise<CaseDetail>;
  addNote(ctx: RequestContext, caseId: string, body: string): Promise<CaseDetail>;
  assignToMe(ctx: RequestContext, caseId: string, expectedVersion: number): Promise<CaseDetail>;
}

const NOTE_ROLES: Role[] = ['operator', 'approver', 'admin'];
const ASSIGN_ROLES: Role[] = ['operator', 'admin'];
export const NOTE_MAX_LENGTH = 2000;

export function createCaseService(db: Db, clock: () => Date): CaseService {
  const loadCaseRow = (ctx: RequestContext, caseId: string): CaseRow => {
    const row = db.prepare('SELECT * FROM payment_cases WHERE id = ? AND organisation_id = ?').get(caseId, ctx.actor.organisationId) as CaseRow | undefined;
    if (!row) throw new AppError('not_found', 'Case not found.');
    return row;
  };

  const userName = (userId: string | null) => {
    if (!userId) return null;
    const user = findUser(db, userId);
    return user ? { id: user.id, displayName: user.displayName } : null;
  };

  const detail = (ctx: RequestContext, caseId: string): CaseDetail => {
    const caseRow = loadCaseRow(ctx, caseId);
    const paymentCase = toCase(caseRow);
    const itemRow = db
      .prepare(
        `SELECT i.*, b.reference AS batch_reference FROM payment_items i JOIN payment_batches b ON b.id = i.batch_id WHERE i.id = ?`,
      )
      .get(caseRow.payment_item_id) as {
      id: string;
      batch_id: string;
      payment_reference: string;
      recipient_reference: string;
      receiver_type: 'EMAIL' | 'PHONE';
      receiver_masked: string;
      amount_minor: number;
      currency: 'USD' | 'EUR' | 'GBP';
      recovery_of_item_id: string | null;
      source_import_row_id: string | null;
      created_at: string;
    };
    const batch = toBatch(db.prepare('SELECT * FROM payment_batches WHERE id = ?').get(itemRow.batch_id) as BatchRow);
    const dataset = loadDataset(db, ctx.actor.organisationId)!;
    const item = dataset.items.find((i) => i.id === itemRow.id)!;

    const fileNames = new Map(
      (db.prepare('SELECT id, file_name FROM imports WHERE organisation_id = ?').all(ctx.actor.organisationId) as { id: string; file_name: string }[]).map(
        (r) => [r.id, r.file_name],
      ),
    );
    const observationRows = db.prepare('SELECT * FROM status_observations WHERE payment_item_id = ? ORDER BY seq DESC').all(item.id) as ObservationRow[];
    const observations: ObservationView[] = observationRows.map((row) => ({
      ...toImportedRecord(row),
      fileName: fileNames.get(row.import_id) ?? 'Unknown file',
      isCurrent: row.id === item.imported?.observationId,
    }));

    const references = new Map(dataset.items.map((i) => [i.id, i.senderItemId]));
    const findings: FindingView[] = (
      db.prepare('SELECT * FROM reconciliation_findings WHERE payment_item_id = ? ORDER BY recorded_at, rowid').all(item.id) as {
        id: string;
        code: FindingCode;
        severity: FindingSeverity;
        detail: string;
        expected: string | null;
        actual: string | null;
        related_item_ids: string;
        import_id: string | null;
        row_number: number | null;
        rule_version: number;
        recorded_at: string;
      }[]
    ).map((f) => ({
      id: f.id,
      code: f.code,
      severity: f.severity,
      detail: f.detail,
      expected: f.expected ? JSON.parse(f.expected) : null,
      actual: f.actual ? JSON.parse(f.actual) : null,
      relatedPayments: (JSON.parse(f.related_item_ids) as string[]).map((id) => ({ id, reference: references.get(id) ?? id })),
      import: f.import_id && f.row_number ? { id: f.import_id, fileName: fileNames.get(f.import_id) ?? 'Unknown file', rowNumber: f.row_number } : null,
      ruleVersion: f.rule_version,
      recordedAt: f.recorded_at,
    }));

    const users = new Map(dataset.users.map((u) => [u.id, u]));
    const timeline: TimelineEvent[] = (
      db
        .prepare('SELECT * FROM payment_events WHERE payment_item_id = ? OR case_id = ? ORDER BY occurred_at, recorded_at, rowid')
        .all(item.id, caseRow.id) as EventRow[]
    ).map((row) => {
      const event = toEvent(row);
      return { ...event, actorName: event.actorUserId ? (users.get(event.actorUserId)?.displayName ?? null) : null };
    });

    const notes: NoteView[] = (
      db.prepare('SELECT * FROM case_notes WHERE case_id = ? ORDER BY created_at, rowid').all(caseRow.id) as {
        id: string;
        body: string;
        author_user_id: string;
        created_at: string;
      }[]
    ).map((n) => ({
      id: n.id,
      body: n.body,
      author: { id: n.author_user_id, displayName: users.get(n.author_user_id)?.displayName ?? 'Unknown user' },
      createdAt: n.created_at,
    }));

    const history: AuditEntryView[] = listAuditEventsForEntity(db, 'payment_case', caseRow.id).map((row) => {
      const actor = row.actor_user_id ? users.get(row.actor_user_id) : undefined;
      return {
        seq: row.seq,
        recordedAt: row.recorded_at,
        action: row.action,
        outcome: row.outcome,
        actor: actor && row.actor_role ? { id: actor.id, displayName: actor.displayName, role: row.actor_role } : null,
        previousState: row.previous_state ? JSON.parse(row.previous_state) : null,
        newState: row.new_state ? JSON.parse(row.new_state) : null,
        reason: row.reason,
      };
    });

    let sourceRow: CaseDetail['sourceRow'] = null;
    if (itemRow.source_import_row_id) {
      const source = db
        .prepare('SELECT r.import_id, r.row_number, r.raw_values, i.file_name, i.headers FROM import_rows r JOIN imports i ON i.id = r.import_id WHERE r.id = ?')
        .get(itemRow.source_import_row_id) as { import_id: string; row_number: number; raw_values: string; file_name: string; headers: string };
      sourceRow = {
        importId: source.import_id,
        fileName: source.file_name,
        rowNumber: source.row_number,
        headers: JSON.parse(source.headers) as string[],
        values: JSON.parse(source.raw_values) as string[],
      };
    }

    const role = ctx.actor.user.role;
    const assignee = userName(paymentCase.assigneeUserId);
    return {
      case: {
        id: paymentCase.id,
        reference: paymentCase.reference,
        state: paymentCase.state,
        basis: paymentCase.basis,
        openingReason: paymentCase.openingReason,
        openedAt: paymentCase.openedAt,
        updatedAt: paymentCase.updatedAt,
        version: paymentCase.version,
        assignee,
        resolution: paymentCase.resolution
          ? {
              kind: paymentCase.resolution.kind,
              summary: paymentCase.resolution.summary,
              resolvedAt: paymentCase.resolution.resolvedAt,
              resolvedBy: userName(paymentCase.resolution.resolvedByUserId),
            }
          : null,
      },
      nextAction: deriveNextAction(paymentCase, item),
      payment: {
        id: item.id,
        reference: item.senderItemId,
        recipientReference: item.recipientReference,
        recipientType: item.recipientType,
        recipientMasked: item.recipientMasked,
        amount: item.amount,
        recordedAt: itemRow.created_at,
        recoveryOf: item.recoveryOfItemId ? { id: item.recoveryOfItemId, reference: references.get(item.recoveryOfItemId) ?? item.recoveryOfItemId } : null,
      },
      batch: {
        id: batch.id,
        reference: batch.reference,
        programme: batch.programme,
        kind: batch.kind,
        origin: batch.origin,
        providerMode: batch.providerMode,
        status: batch.status,
        submittedAt: batch.submittedAt,
      },
      provider: item.provider,
      imported: observations.find((o) => o.isCurrent) ?? null,
      observations,
      recoveries: dataset.items
        .filter((i) => i.recoveryOfItemId === item.id)
        .map((i) => ({ id: i.id, reference: i.senderItemId, amount: i.amount, providerStatus: i.provider?.status ?? null })),
      findings,
      timeline,
      notes,
      history,
      sourceRow,
      permissions: {
        canAssign:
          ASSIGN_ROLES.includes(role) &&
          (paymentCase.state === 'open' || paymentCase.state === 'investigating') &&
          paymentCase.assigneeUserId !== ctx.actor.user.id,
        canAddNote: NOTE_ROLES.includes(role),
      },
    };
  };

  return {
    async list(ctx, query) {
      const dataset = loadDataset(db, ctx.actor.organisationId);
      if (!dataset) throw new AppError('not_found', 'Organisation data not found.');
      const items = new Map(dataset.items.map((i) => [i.id, i]));
      const batches = new Map(dataset.batches.map((b) => [b.id, b]));
      const users = new Map(dataset.users.map((u) => [u.id, u]));
      const caseIdsForImport = query.import
        ? new Set(
            (
              db
                .prepare('SELECT DISTINCT cf.case_id FROM case_findings cf JOIN reconciliation_findings f ON f.id = cf.finding_id WHERE f.import_id = ?')
                .all(query.import) as { case_id: string }[]
            ).map((r) => r.case_id),
          )
        : null;

      const rows: CaseListItem[] = dataset.cases.flatMap((c: PaymentCase) => {
        const item = items.get(c.paymentItemId);
        const batch = item ? batches.get(item.batchId) : undefined;
        if (!item || !batch) return [];
        const assignee = c.assigneeUserId ? users.get(c.assigneeUserId) : undefined;
        return [
          {
            id: c.id,
            reference: c.reference,
            state: c.state,
            basis: c.basis,
            openingReason: c.openingReason,
            openedAt: c.openedAt,
            updatedAt: c.updatedAt,
            version: c.version,
            payment: {
              id: item.id,
              reference: item.senderItemId,
              recipientReference: item.recipientReference,
              amount: item.amount,
              batchId: batch.id,
              batchReference: batch.reference,
            },
            status: reportedStatus(item),
            nextAction: deriveNextAction(c, item),
            assignee: assignee ? { id: assignee.id, displayName: assignee.displayName } : null,
          },
        ];
      });

      const needle = query.q?.trim().toLowerCase();
      const state = query.state ?? 'active';
      const filtered = rows.filter((row) => {
        if (state === 'active' && !isCaseActive(row.state)) return false;
        if (state !== 'active' && state !== 'all' && row.state !== state) return false;
        if (query.status && row.status?.status !== query.status) return false;
        if (query.source && row.status?.source !== query.source) return false;
        if (query.nextAction && row.nextAction.code !== query.nextAction) return false;
        if (query.basis && row.basis !== query.basis) return false;
        if (query.batch && row.payment.batchId !== query.batch) return false;
        if (query.assignee === 'me' && row.assignee?.id !== ctx.actor.user.id) return false;
        if (query.assignee === 'unassigned' && row.assignee) return false;
        if (caseIdsForImport && !caseIdsForImport.has(row.id)) return false;
        if (needle) {
          const haystack = [row.reference, row.payment.reference, row.payment.recipientReference, row.payment.batchReference].join(' ').toLowerCase();
          if (!haystack.includes(needle)) return false;
        }
        return true;
      });

      const direction = query.order === 'asc' ? 1 : -1;
      const caseNumber = (reference: string) => Number(reference.replace(/\D/g, '')) || 0;
      const compare: Record<CaseSortField, (a: CaseListItem, b: CaseListItem) => number> = {
        opened: (a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt),
        updated: (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
        amount: (a, b) => a.payment.amount.currency.localeCompare(b.payment.amount.currency) || a.payment.amount.minor - b.payment.amount.minor,
        reference: (a, b) => caseNumber(a.reference) - caseNumber(b.reference),
        // Cases without a deadline always sort after those with one.
        due: (a, b) => {
          const da = a.nextAction.dueAt ? Date.parse(a.nextAction.dueAt) : null;
          const dbb = b.nextAction.dueAt ? Date.parse(b.nextAction.dueAt) : null;
          if (da !== null && dbb !== null) return (da - dbb) * direction;
          if (da !== null) return -1;
          if (dbb !== null) return 1;
          return (Date.parse(b.updatedAt) - Date.parse(a.updatedAt)) * direction;
        },
      };
      const sorted = [...filtered].sort((a, b) => {
        const primary = query.sort === 'due' ? compare.due(a, b) : compare[query.sort](a, b) * direction;
        return primary || caseNumber(b.reference) - caseNumber(a.reference);
      });

      const start = (query.page - 1) * query.pageSize;
      return {
        cases: sorted.slice(start, start + query.pageSize),
        page: query.page,
        pageSize: query.pageSize,
        total: sorted.length,
        batches: dataset.batches.map((b) => ({ id: b.id, reference: b.reference })).sort((a, b) => b.reference.localeCompare(a.reference)),
      };
    },

    async get(ctx, caseId) {
      return detail(ctx, caseId);
    },

    async addNote(ctx, caseId, body) {
      assertRole(db, ctx, NOTE_ROLES, 'case.note_added', 'payment_case', caseId);
      loadCaseRow(ctx, caseId);
      const text = body.trim();
      if (text.length === 0 || text.length > NOTE_MAX_LENGTH) {
        throw new AppError('validation_failed', `A note must be between 1 and ${NOTE_MAX_LENGTH} characters.`);
      }
      if (findContactDetails(text).length > 0) {
        auditRejection(db, ctx, 'case.note_added', 'payment_case', caseId, 'Note contained contact details and was not saved.');
        throw new AppError(
          'validation_failed',
          'Notes must not contain email addresses or phone numbers. Refer to recipients by their programme reference. The note was not saved.',
          { reason: 'personal_data_in_note' },
        );
      }
      try {
        db.transaction(() => {
          const noteId = `note_${randomUUID()}`;
          db.prepare('INSERT INTO case_notes (id, case_id, author_user_id, body) VALUES (?, ?, ?, ?)').run(noteId, caseId, ctx.actor.user.id, text);
          appendAudit(db, {
            organisationId: ctx.actor.organisationId,
            actor: auditActor(ctx),
            action: 'case.note_added',
            entityType: 'payment_case',
            entityId: caseId,
            outcome: 'succeeded',
            requestId: ctx.requestId,
            newState: { noteId, length: text.length },
          });
        }).immediate();
      } catch (error) {
        rethrowBusy(error);
      }
      return detail(ctx, caseId);
    },

    async assignToMe(ctx, caseId, expectedVersion) {
      assertRole(db, ctx, ASSIGN_ROLES, 'case.assigned', 'payment_case', caseId);
      try {
        db.transaction(() => {
          const row = loadCaseRow(ctx, caseId);
          if (row.version !== expectedVersion) {
            throw new AppError('conflict', 'This case changed since you opened it. Review the latest details before assigning it.', {
              reason: 'stale_version',
              currentVersion: row.version,
            });
          }
          if (row.state !== 'open' && row.state !== 'investigating') {
            throw new AppError('conflict', 'Only open or investigating cases can be assigned.');
          }
          if (row.assignee_user_id === ctx.actor.user.id && row.state === 'investigating') {
            throw new AppError('conflict', 'This case is already assigned to you.');
          }
          const now = clock().toISOString();
          db.prepare("UPDATE payment_cases SET state = 'investigating', assignee_user_id = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(
            ctx.actor.user.id,
            now,
            caseId,
          );
          const batch = db.prepare('SELECT batch_id FROM payment_items WHERE id = ?').get(row.payment_item_id) as { batch_id: string };
          db.prepare(
            `INSERT INTO payment_events (id, organisation_id, batch_id, payment_item_id, case_id, type, source, occurred_at,
               previous_case_state, new_case_state, actor_user_id, summary)
             VALUES (?, ?, ?, ?, ?, 'case_assigned', 'operator', ?, ?, 'investigating', ?, ?)`,
          ).run(
            `evt_${randomUUID()}`,
            ctx.actor.organisationId,
            batch.batch_id,
            row.payment_item_id,
            caseId,
            now,
            row.state,
            ctx.actor.user.id,
            `Assigned to ${ctx.actor.user.displayName}; investigation started.`,
          );
          appendAudit(db, {
            organisationId: ctx.actor.organisationId,
            actor: auditActor(ctx),
            action: 'case.assigned',
            entityType: 'payment_case',
            entityId: caseId,
            outcome: 'succeeded',
            requestId: ctx.requestId,
            previousState: { state: row.state, assigneeUserId: row.assignee_user_id, version: row.version },
            newState: { state: 'investigating', assigneeUserId: ctx.actor.user.id, version: row.version + 1 },
          });
        }).immediate();
      } catch (error) {
        if (error instanceof AppError) auditRejection(db, ctx, 'case.assigned', 'payment_case', caseId, error.message);
        rethrowBusy(error);
      }
      return detail(ctx, caseId);
    },
  };
}
