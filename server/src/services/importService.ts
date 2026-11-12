import { randomUUID } from 'node:crypto';
import type {
  CommitImportResponse,
  ImportDetail,
  ImportListItem,
  ImportListResponse,
  ImportResult,
  ImportRowsResponse,
  ImportRowView,
  ImportSummary,
  UploadImportResponse,
} from '@shared/api/contracts';
import { describeOpeningReason, FINDING_INFO, RECONCILIATION_RULE_VERSION, type FindingCode } from '@shared/domain/findings';
import type { ColumnMapping, ImportStatus, RowIssue, RowIssueCode, RowOutcome } from '@shared/domain/imports';
import type { CurrencyCode } from '@shared/domain/money';
import type { PayoutItemStatus } from '@shared/domain/paypal';
import type { BatchOrigin, CaseBasis } from '@shared/domain/types';
import { appendAudit } from '../audit/auditLog';
import type { Db } from '../db/connection';
import { CsvFileError, parseCsvFile } from '../imports/csvFile';
import { suggestMapping, validateMapping } from '../imports/mapping';
import { screenForRealContactDetails } from '../imports/privacy';
import { planImport, type ExistingItem, type ImportPlan, type PlannedFinding, type ReconciliationContext } from '../imports/reconcile';
import { validateRow } from '../imports/validateRow';
import { AppError } from '../lib/errors';
import { maskReceiver } from '../lib/paymentIdentity';
import { assertRole, auditActor, auditRejection, rethrowBusy, type RequestContext } from './context';
import { nextCaseReference } from './caseReferences';

export interface ImportService {
  upload(ctx: RequestContext, fileName: string, bytes: Uint8Array): Promise<UploadImportResponse>;
  list(ctx: RequestContext): Promise<ImportListResponse>;
  get(ctx: RequestContext, importId: string): Promise<ImportDetail>;
  applyMapping(ctx: RequestContext, importId: string, mapping: ColumnMapping): Promise<ImportDetail>;
  rows(ctx: RequestContext, importId: string, query: ImportRowsQuery): Promise<ImportRowsResponse>;
  commit(ctx: RequestContext, importId: string, request: { validationVersion: number }): Promise<CommitImportResponse>;
  discard(ctx: RequestContext, importId: string): Promise<ImportDetail>;
}

export interface ImportRowsQuery {
  outcome?: RowOutcome;
  issue?: RowIssueCode;
  page: number;
  pageSize: number;
}

const IMPORT_ROLES = ['operator', 'admin'] as const;
const PREVIEW_ROWS = 8;

interface ImportRow {
  id: string;
  organisation_id: string;
  file_name: string;
  file_sha256: string;
  file_size_bytes: number;
  headers: string;
  row_count: number;
  status: ImportStatus;
  mapping: string | null;
  validation_version: number;
  plan_digest: string | null;
  summary: string | null;
  result: string | null;
  is_synthetic: number;
  uploaded_by_user_id: string;
  uploaded_by_name: string;
  uploaded_at: string;
  validated_at: string | null;
  committed_at: string | null;
  committed_by_user_id: string | null;
  committed_by_name: string | null;
  discarded_at: string | null;
}

class StaleImportError extends Error {}

const IMPORT_SELECT = `
  SELECT i.*, u.display_name AS uploaded_by_name, c.display_name AS committed_by_name
  FROM imports i
  JOIN users u ON u.id = i.uploaded_by_user_id
  LEFT JOIN users c ON c.id = i.committed_by_user_id`;

/** Strips any path and control characters from a client-supplied file name. */
export function sanitiseFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
}

const FINDING_PRIORITY: FindingCode[] = [
  'reference_conflict',
  'provider_status_conflict',
  'provider_reference_mismatch',
  'error_code_on_success',
  'possible_duplicate_payment',
  'stale_unclaimed',
  'stale_pending',
  'exception_status_recorded',
];

export function createImportService(db: Db, clock: () => Date): ImportService {
  const loadImport = (ctx: RequestContext, importId: string): ImportRow => {
    const row = db.prepare(`${IMPORT_SELECT} WHERE i.id = ? AND i.organisation_id = ?`).get(importId, ctx.actor.organisationId) as ImportRow | undefined;
    if (!row) throw new AppError('not_found', 'Import not found.');
    return row;
  };

  const toListItem = (row: ImportRow): ImportListItem => ({
    id: row.id,
    fileName: row.file_name,
    status: row.status,
    rowCount: row.row_count,
    isSynthetic: row.is_synthetic === 1,
    uploadedAt: row.uploaded_at,
    uploadedBy: { id: row.uploaded_by_user_id, displayName: row.uploaded_by_name },
    committedAt: row.committed_at,
    summary: row.summary ? (JSON.parse(row.summary) as ImportSummary) : null,
    result: row.result ? (JSON.parse(row.result) as ImportResult) : null,
  });

  const toDetail = (row: ImportRow): ImportDetail => {
    const headers = JSON.parse(row.headers) as string[];
    const previewRows = (
      db.prepare('SELECT row_number, raw_values FROM import_rows WHERE import_id = ? ORDER BY row_number LIMIT ?').all(row.id, PREVIEW_ROWS) as {
        row_number: number;
        raw_values: string;
      }[]
    ).map((r) => ({ rowNumber: r.row_number, values: JSON.parse(r.raw_values) as string[] }));
    return {
      ...toListItem(row),
      sizeBytes: row.file_size_bytes,
      fileSha256: row.file_sha256,
      headers,
      mapping: row.mapping ? (JSON.parse(row.mapping) as ColumnMapping) : null,
      suggestedMapping: suggestMapping(headers),
      validationVersion: row.validation_version,
      validatedAt: row.validated_at,
      committedBy: row.committed_by_user_id ? { id: row.committed_by_user_id, displayName: row.committed_by_name ?? '' } : null,
      discardedAt: row.discarded_at,
      previewRows,
    };
  };

  /** Reads existing records lazily, inside whatever transaction is open. */
  const reconciliationContext = (organisationId: string): ReconciliationContext => {
    const itemByRef = db.prepare(
      `SELECT i.*, b.reference AS batch_reference FROM payment_items i JOIN payment_batches b ON b.id = i.batch_id
       WHERE i.organisation_id = ? AND i.payment_reference = ?`,
    );
    const itemsByBatch = db.prepare(
      `SELECT i.*, b.reference AS batch_reference FROM payment_items i JOIN payment_batches b ON b.id = i.batch_id WHERE i.batch_id = ?`,
    );
    const providerByItem = db.prepare('SELECT status, provider_item_id, provider_transaction_id FROM provider_transactions WHERE payment_item_id = ?');
    const observationsByItem = db.prepare('SELECT status, status_at, error_code, recorded_at FROM status_observations WHERE payment_item_id = ? ORDER BY seq');
    const batchByRef = db.prepare('SELECT id, reference, origin, programme FROM payment_batches WHERE organisation_id = ? AND reference = ?');

    type Row = {
      id: string;
      payment_reference: string;
      batch_id: string;
      batch_reference: string;
      recipient_reference: string;
      amount_minor: number;
      currency: CurrencyCode;
      fingerprint: string;
    };
    const toExisting = (row: Row): ExistingItem => {
      const provider = providerByItem.get(row.id) as
        | { status: PayoutItemStatus; provider_item_id: string | null; provider_transaction_id: string | null }
        | undefined;
      const observations = observationsByItem.all(row.id) as { status: PayoutItemStatus; status_at: string | null; error_code: string | null; recorded_at: string }[];
      return {
        id: row.id,
        paymentReference: row.payment_reference,
        batchId: row.batch_id,
        batchReference: row.batch_reference,
        recipientReference: row.recipient_reference,
        amountMinor: row.amount_minor,
        currency: row.currency,
        fingerprint: row.fingerprint,
        provider: provider ? { status: provider.status, providerItemId: provider.provider_item_id, providerTransactionId: provider.provider_transaction_id } : null,
        observations: observations.map((o) => ({ status: o.status, statusAt: o.status_at, errorCode: o.error_code, recordedAt: o.recorded_at })),
      };
    };
    return {
      findItem: (ref) => {
        const row = itemByRef.get(organisationId, ref) as Row | undefined;
        return row ? toExisting(row) : undefined;
      },
      findBatch: (ref) => batchByRef.get(organisationId, ref) as { id: string; reference: string; origin: BatchOrigin; programme: string } | undefined,
      itemsInBatch: (batchId) => (itemsByBatch.all(batchId) as Row[]).map(toExisting),
    };
  };

  const computePlan = (row: ImportRow, mapping: ColumnMapping): ImportPlan => {
    const headers = JSON.parse(row.headers) as string[];
    const now = clock();
    const fileRows = db.prepare('SELECT row_number, raw_values FROM import_rows WHERE import_id = ? ORDER BY row_number').all(row.id) as {
      row_number: number;
      raw_values: string;
    }[];
    return planImport(
      fileRows.map((r) => ({ rowNumber: r.row_number, validation: validateRow(JSON.parse(r.raw_values) as string[], headers.length, mapping, now) })),
      reconciliationContext(row.organisation_id),
    );
  };

  /** Stores a new validation version. Earlier versions remain in import_row_results. */
  const storeValidation = (ctx: RequestContext, row: ImportRow, mapping: ColumnMapping, plan: ImportPlan): number => {
    const version = row.validation_version + 1;
    const insert = db.prepare(
      `INSERT INTO import_row_results (import_id, validation_version, row_number, outcome, normalised, issues, matched_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const planned of plan.rows) {
      const n = planned.normalised;
      insert.run(
        row.id,
        version,
        planned.rowNumber,
        planned.outcome,
        n
          ? JSON.stringify({
              paymentReference: n.paymentReference,
              batchReference: n.batchReference,
              recipientReference: n.recipientReference,
              amount: { currency: n.currency, minor: n.amountMinor },
              receiverType: n.receiverType,
              receiverMasked: maskReceiver(n.receiverType, n.receiver),
              recordedStatus: n.recordedStatus,
              statusAt: n.statusAt,
            } satisfies ImportRowView['normalised'])
          : null,
        JSON.stringify(planned.issues),
        planned.matchedItemId,
      );
    }
    db.prepare(
      `UPDATE imports SET status = 'validated', mapping = ?, validation_version = ?, plan_digest = ?, summary = ?,
         validated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    ).run(JSON.stringify(mapping), version, plan.digest, JSON.stringify(plan.summary), row.id);
    appendAudit(db, {
      organisationId: ctx.actor.organisationId,
      actor: auditActor(ctx),
      action: 'import.validated',
      entityType: 'import',
      entityId: row.id,
      outcome: 'succeeded',
      requestId: ctx.requestId,
      previousState: { status: row.status, validationVersion: row.validation_version },
      newState: { status: 'validated', validationVersion: version, outcomes: plan.summary.outcomes },
    });
    return version;
  };

  const applyPlan = (ctx: RequestContext, row: ImportRow, plan: ImportPlan): ImportResult => {
    const organisationId = ctx.actor.organisationId;
    const userId = ctx.actor.user.id;
    const now = clock().toISOString();
    const context = reconciliationContext(organisationId);
    const rowIds = new Map(
      (db.prepare('SELECT id, row_number FROM import_rows WHERE import_id = ?').all(row.id) as { id: string; row_number: number }[]).map((r) => [
        r.row_number,
        r.id,
      ]),
    );

    const insertEvent = db.prepare(
      `INSERT INTO payment_events (id, organisation_id, batch_id, payment_item_id, case_id, import_id, type, source, occurred_at,
         previous_status, new_status, previous_case_state, new_case_state, actor_user_id, summary)
       VALUES (@id, @organisationId, @batchId, @itemId, @caseId, @importId, @type, @source, @occurredAt,
         @previousStatus, @newStatus, @previousCaseState, @newCaseState, @actorUserId, @summary)`,
    );
    const event = (values: {
      batchId: string;
      itemId?: string | null;
      caseId?: string | null;
      type: string;
      source: 'import' | 'system';
      previousStatus?: string | null;
      newStatus?: string | null;
      previousCaseState?: string | null;
      newCaseState?: string | null;
      actorUserId?: string | null;
      summary: string;
    }) =>
      insertEvent.run({
        id: `evt_${randomUUID()}`,
        organisationId,
        importId: row.id,
        occurredAt: now,
        itemId: null,
        caseId: null,
        previousStatus: null,
        newStatus: null,
        previousCaseState: null,
        newCaseState: null,
        actorUserId: null,
        ...values,
      });

    // Batches referenced by new payments.
    const batchIds = new Map<string, string>();
    const batchesCreated: ImportResult['batchesCreated'] = [];
    const newRows = plan.rows.filter((r) => r.outcome === 'new_payment' && r.normalised);
    for (const reference of [...new Set(newRows.map((r) => r.normalised!.batchReference))]) {
      const existing = context.findBatch(reference);
      if (existing) {
        batchIds.set(reference, existing.id);
        continue;
      }
      const id = `bat_${randomUUID()}`;
      const programme = newRows.find((r) => r.normalised!.batchReference === reference && r.normalised!.programme)?.normalised!.programme ?? 'Programme not specified';
      db.prepare(
        `INSERT INTO payment_batches (id, organisation_id, reference, kind, origin, programme, created_by_user_id, source_import_id)
         VALUES (?, ?, ?, 'disbursement', 'csv_import', ?, ?, ?)`,
      ).run(id, organisationId, reference, programme, userId, row.id);
      batchIds.set(reference, id);
      batchesCreated.push({ id, reference });
      const count = newRows.filter((r) => r.normalised!.batchReference === reference).length;
      event({
        batchId: id,
        type: 'batch_imported',
        source: 'import',
        actorUserId: userId,
        summary: `Imported ${count} payment record${count === 1 ? '' : 's'} from ${row.file_name}. Not submitted to the provider by ReliefRelay.`,
      });
    }

    // New payments.
    const itemIdByRow = new Map<number, string>();
    const batchIdByItem = new Map<string, string>();
    const insertItem = db.prepare(
      `INSERT INTO payment_items (id, organisation_id, batch_id, payment_reference, recipient_reference, receiver_type, receiver_value,
         receiver_masked, amount_minor, currency, fingerprint, source_import_row_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const planned of newRows) {
      const n = planned.normalised!;
      const id = `itm_${randomUUID()}`;
      const batchId = batchIds.get(n.batchReference)!;
      insertItem.run(
        id,
        organisationId,
        batchId,
        n.paymentReference,
        n.recipientReference,
        n.receiverType,
        n.receiver,
        maskReceiver(n.receiverType, n.receiver),
        n.amountMinor,
        n.currency,
        planned.fingerprint,
        rowIds.get(planned.rowNumber),
      );
      itemIdByRow.set(planned.rowNumber, id);
      batchIdByItem.set(id, batchId);
    }
    for (const planned of plan.rows) {
      if (planned.matchedItemId && !batchIdByItem.has(planned.matchedItemId)) {
        const found = db.prepare('SELECT batch_id FROM payment_items WHERE id = ?').get(planned.matchedItemId) as { batch_id: string };
        batchIdByItem.set(planned.matchedItemId, found.batch_id);
      }
    }

    // Status observations: appended, never overwriting earlier observations or provider records.
    let statusObservations = 0;
    const insertObservation = db.prepare(
      `INSERT INTO status_observations (id, organisation_id, payment_item_id, import_id, import_row_id, row_number, status, status_at,
         error_code, claimed_provider_item_id, claimed_provider_transaction_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const planned of plan.rows) {
      if ((planned.outcome !== 'new_payment' && planned.outcome !== 'status_update') || !planned.normalised?.recordedStatus) continue;
      const n = planned.normalised;
      const itemId = planned.matchedItemId ?? itemIdByRow.get(planned.rowNumber)!;
      const previous = planned.matchedItemId ? context.findItem(n.paymentReference) : undefined;
      const previousStatus = previous?.observations.length
        ? [...previous.observations].sort((a, b) => Date.parse(b.statusAt ?? b.recordedAt) - Date.parse(a.statusAt ?? a.recordedAt))[0]!.status
        : null;
      insertObservation.run(
        `obs_${randomUUID()}`,
        organisationId,
        itemId,
        row.id,
        rowIds.get(planned.rowNumber),
        planned.rowNumber,
        n.recordedStatus,
        n.statusAt,
        n.errorCode,
        n.providerItemId,
        n.providerTransactionId,
      );
      statusObservations += 1;
      event({
        batchId: batchIdByItem.get(itemId)!,
        itemId,
        type: 'status_observed',
        source: 'import',
        previousStatus,
        newStatus: n.recordedStatus,
        actorUserId: userId,
        summary: `Imported record shows ${n.recordedStatus} (${row.file_name}, row ${planned.rowNumber}). Not confirmed by the provider.`,
      });
    }

    // Findings, then cases.
    const insertFinding = db.prepare(
      `INSERT INTO reconciliation_findings (id, organisation_id, payment_item_id, import_id, row_number, code, severity, expected, actual,
         related_item_ids, detail, rule_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const findingsByItem = new Map<string, { id: string; finding: PlannedFinding }[]>();
    let findingsRecorded = 0;
    for (const planned of plan.rows) {
      if (planned.findings.length === 0) continue;
      const itemId = planned.matchedItemId ?? itemIdByRow.get(planned.rowNumber);
      if (!itemId) continue;
      for (const finding of planned.findings) {
        const id = `fnd_${randomUUID()}`;
        const related = [...finding.relatedItemIds, ...finding.relatedRowNumbers.flatMap((n) => itemIdByRow.get(n) ?? [])];
        insertFinding.run(
          id,
          organisationId,
          itemId,
          row.id,
          planned.rowNumber,
          finding.code,
          FINDING_INFO[finding.code].severity,
          finding.expected === null || finding.expected === undefined ? null : JSON.stringify(finding.expected),
          finding.actual === null || finding.actual === undefined ? null : JSON.stringify(finding.actual),
          JSON.stringify(related),
          finding.detail.slice(0, 1000),
          RECONCILIATION_RULE_VERSION,
        );
        findingsRecorded += 1;
        findingsByItem.set(itemId, [...(findingsByItem.get(itemId) ?? []), { id, finding }]);
      }
    }

    const casesOpened: ImportResult['casesOpened'] = [];
    const casesUpdated: ImportResult['casesUpdated'] = [];
    const linkFinding = db.prepare('INSERT INTO case_findings (case_id, finding_id) VALUES (?, ?)');
    for (const [itemId, findings] of findingsByItem) {
      const active = db
        .prepare("SELECT id, reference, state FROM payment_cases WHERE payment_item_id = ? AND state NOT IN ('resolved', 'closed')")
        .get(itemId) as { id: string; reference: string; state: string } | undefined;
      const batchId = batchIdByItem.get(itemId)!;
      const significant = findings.filter(({ finding }) => FINDING_INFO[finding.code].severity !== 'info');

      if (active) {
        for (const { id } of findings) linkFinding.run(active.id, id);
        if (significant.length === 0) continue;
        db.prepare('UPDATE payment_cases SET updated_at = ?, version = version + 1 WHERE id = ?').run(now, active.id);
        event({
          batchId,
          itemId,
          caseId: active.id,
          type: 'finding_recorded',
          source: 'system',
          summary: `${significant.map(({ finding }) => FINDING_INFO[finding.code].label).join('; ')} (${row.file_name}). Added to case ${active.reference}.`,
        });
        appendAudit(db, {
          organisationId,
          actor: { type: 'system' },
          action: 'case.findings_added',
          entityType: 'payment_case',
          entityId: active.id,
          outcome: 'succeeded',
          requestId: ctx.requestId,
          newState: { findings: significant.map(({ finding }) => finding.code), importId: row.id },
          reason: `Reconciliation rules (version ${RECONCILIATION_RULE_VERSION}) during import ${row.file_name}.`,
        });
        casesUpdated.push({ id: active.id, reference: active.reference });
        continue;
      }

      const openers = findings.filter(({ finding }) => finding.opensCase);
      if (openers.length === 0) {
        if (significant.length > 0) {
          event({
            batchId,
            itemId,
            type: 'finding_recorded',
            source: 'system',
            summary: `${significant.map(({ finding }) => FINDING_INFO[finding.code].label).join('; ')} (${row.file_name}).`,
          });
        }
        continue;
      }
      const reason = FINDING_PRIORITY.find((code) => openers.some(({ finding }) => finding.code === code))!;
      const basis: CaseBasis = openers.some(({ finding }) => FINDING_INFO[finding.code].opensCase === 'reconciliation_conflict')
        ? 'reconciliation_conflict'
        : 'imported_record';
      const caseId = `case_${randomUUID()}`;
      const reference = nextCaseReference(db, organisationId);
      db.prepare(
        `INSERT INTO payment_cases (id, organisation_id, reference, payment_item_id, state, basis, opening_reason, opened_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      ).run(caseId, organisationId, reference, itemId, basis, reason, now, now);
      for (const { id } of findings) linkFinding.run(caseId, id);
      event({
        batchId,
        itemId,
        caseId,
        type: 'case_opened',
        source: 'system',
        newCaseState: 'open',
        summary: `Case opened automatically: ${describeOpeningReason(reason).toLowerCase()} (${row.file_name}).`,
      });
      appendAudit(db, {
        organisationId,
        actor: { type: 'system' },
        action: 'case.opened',
        entityType: 'payment_case',
        entityId: caseId,
        outcome: 'succeeded',
        requestId: ctx.requestId,
        newState: { reference, state: 'open', basis, openingReason: reason, paymentItemId: itemId, importId: row.id },
        reason: `Reconciliation rules (version ${RECONCILIATION_RULE_VERSION}) during import ${row.file_name}.`,
      });
      casesOpened.push({ id: caseId, reference });
    }

    return {
      newPayments: newRows.length,
      statusObservations,
      unchanged: plan.summary.outcomes.unchanged,
      rejected: plan.summary.outcomes.rejected,
      findingsRecorded,
      batchesCreated,
      casesOpened,
      casesUpdated,
    };
  };

  return {
    async upload(ctx, fileName, bytes) {
      assertRole(db, ctx, [...IMPORT_ROLES], 'import.uploaded', 'import', null);
      const name = sanitiseFileName(fileName);
      if (!/\.csv$/i.test(name)) {
        auditRejection(db, ctx, 'import.rejected', 'import', null, 'File name does not end in .csv.');
        throw new AppError('validation_failed', 'Upload a .csv file. Export it from your spreadsheet as CSV (UTF-8).');
      }

      let parsed;
      try {
        parsed = parseCsvFile(bytes);
      } catch (error) {
        if (error instanceof CsvFileError) {
          auditRejection(db, ctx, 'import.rejected', 'import', null, error.message, { reason: error.code, sizeBytes: bytes.byteLength });
          throw new AppError('validation_failed', error.message, { reason: error.code, ...error.details });
        }
        throw error;
      }

      const hits = screenForRealContactDetails(parsed.headers, parsed.rows);
      if (hits.length > 0) {
        const rowsAffected = new Set(hits.map((h) => h.rowNumber)).size;
        auditRejection(db, ctx, 'import.rejected', 'import', null, 'File contains real-looking contact details. Nothing was stored.', {
          reason: 'real_contact_details',
          fileSha256: parsed.sha256,
          emails: hits.filter((h) => h.kind === 'email').length,
          phones: hits.filter((h) => h.kind === 'phone').length,
          rowsAffected,
        });
        throw new AppError(
          'validation_failed',
          `This file contains ${hits.length} real-looking contact detail${hits.length === 1 ? '' : 's'} in ${rowsAffected} row${rowsAffected === 1 ? '' : 's'}. ` +
            'The demo organisation accepts synthetic data only: use addresses on reserved test domains such as example.org, or fictional numbers. Nothing was stored.',
          { reason: 'real_contact_details', locations: hits.slice(0, 50) },
        );
      }

      try {
        return db
          .transaction((): UploadImportResponse => {
            const duplicate = db
              .prepare(`${IMPORT_SELECT} WHERE i.organisation_id = ? AND i.file_sha256 = ? AND i.status <> 'discarded'`)
              .get(ctx.actor.organisationId, parsed.sha256) as ImportRow | undefined;
            if (duplicate) {
              auditRejection(db, ctx, 'import.duplicate_file', 'import', duplicate.id, 'An identical file was already uploaded. Nothing new was stored.', {
                fileSha256: parsed.sha256,
              });
              return { import: toDetail(duplicate), alreadyUploaded: true };
            }
            const organisation = db.prepare('SELECT is_synthetic FROM organisations WHERE id = ?').get(ctx.actor.organisationId) as { is_synthetic: number };
            const id = `imp_${randomUUID()}`;
            db.prepare(
              `INSERT INTO imports (id, organisation_id, file_name, file_sha256, file_size_bytes, headers, row_count, status, is_synthetic, uploaded_by_user_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
            ).run(id, ctx.actor.organisationId, name, parsed.sha256, parsed.sizeBytes, JSON.stringify(parsed.headers), parsed.rows.length, organisation.is_synthetic, ctx.actor.user.id);
            const insertRow = db.prepare('INSERT INTO import_rows (id, import_id, row_number, raw_values) VALUES (?, ?, ?, ?)');
            for (const r of parsed.rows) insertRow.run(`row_${randomUUID()}`, id, r.rowNumber, JSON.stringify(r.values));
            appendAudit(db, {
              organisationId: ctx.actor.organisationId,
              actor: auditActor(ctx),
              action: 'import.uploaded',
              entityType: 'import',
              entityId: id,
              outcome: 'succeeded',
              requestId: ctx.requestId,
              newState: { status: 'draft', fileName: name, fileSha256: parsed.sha256, sizeBytes: parsed.sizeBytes, rows: parsed.rows.length },
            });
            return { import: toDetail(loadImport(ctx, id)), alreadyUploaded: false };
          })
          .immediate();
      } catch (error) {
        rethrowBusy(error);
      }
    },

    async list(ctx) {
      const rows = db.prepare(`${IMPORT_SELECT} WHERE i.organisation_id = ? ORDER BY i.uploaded_at DESC LIMIT 50`).all(ctx.actor.organisationId) as ImportRow[];
      return { imports: rows.map(toListItem) };
    },

    async get(ctx, importId) {
      return toDetail(loadImport(ctx, importId));
    },

    async applyMapping(ctx, importId, mapping) {
      assertRole(db, ctx, [...IMPORT_ROLES], 'import.validated', 'import', importId);
      const current = loadImport(ctx, importId);
      if (current.status === 'committed' || current.status === 'discarded') {
        auditRejection(db, ctx, 'import.validated', 'import', importId, `Import is ${current.status}.`);
        throw new AppError('conflict', `This import has been ${current.status} and can no longer be changed.`);
      }
      const problems = validateMapping(mapping, (JSON.parse(current.headers) as string[]).length);
      if (problems.length > 0) throw new AppError('validation_failed', 'The column mapping is incomplete.', { problems });
      try {
        return db
          .transaction(() => {
            const row = loadImport(ctx, importId);
            if (row.status === 'committed' || row.status === 'discarded') throw new AppError('conflict', `This import has been ${row.status}.`);
            storeValidation(ctx, row, mapping, computePlan(row, mapping));
            return toDetail(loadImport(ctx, importId));
          })
          .immediate();
      } catch (error) {
        rethrowBusy(error);
      }
    },

    async rows(ctx, importId, query) {
      const row = loadImport(ctx, importId);
      if (row.validation_version === 0) throw new AppError('conflict', 'Map the columns and validate the file first.');
      const where = ['res.import_id = @importId', 'res.validation_version = @version'];
      if (query.outcome) where.push('res.outcome = @outcome');
      if (query.issue) where.push("EXISTS (SELECT 1 FROM json_each(res.issues) WHERE json_extract(value, '$.code') = @issue)");
      const params = { importId, version: row.validation_version, outcome: query.outcome ?? null, issue: query.issue ?? null };
      const from = `FROM import_row_results res JOIN import_rows r ON r.import_id = res.import_id AND r.row_number = res.row_number WHERE ${where.join(' AND ')}`;
      const total = (db.prepare(`SELECT count(*) AS n ${from}`).get(params) as { n: number }).n;
      const results = db
        .prepare(`SELECT res.row_number, r.raw_values, res.outcome, res.normalised, res.issues, res.matched_item_id ${from} ORDER BY res.row_number LIMIT @limit OFFSET @offset`)
        .all({ ...params, limit: query.pageSize, offset: (query.page - 1) * query.pageSize }) as {
        row_number: number;
        raw_values: string;
        outcome: RowOutcome;
        normalised: string | null;
        issues: string;
        matched_item_id: string | null;
      }[];
      return {
        rows: results.map((r) => ({
          rowNumber: r.row_number,
          values: JSON.parse(r.raw_values) as string[],
          outcome: r.outcome,
          issues: JSON.parse(r.issues) as RowIssue[],
          normalised: r.normalised ? (JSON.parse(r.normalised) as ImportRowView['normalised']) : null,
          matchedPaymentId: r.matched_item_id,
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
        validationVersion: row.validation_version,
      };
    },

    async commit(ctx, importId, { validationVersion }) {
      assertRole(db, ctx, [...IMPORT_ROLES], 'import.committed', 'import', importId);
      try {
        return db
          .transaction((): CommitImportResponse => {
            const row = loadImport(ctx, importId);
            if (row.status === 'committed') return { import: toDetail(row), alreadyCommitted: true };
            if (row.status === 'discarded') throw new AppError('conflict', 'This import was discarded and cannot be committed.');
            if (row.status !== 'validated' || !row.mapping) throw new AppError('conflict', 'Map the columns and validate the file before committing.');
            if (row.validation_version !== validationVersion) throw new StaleImportError();
            const plan = computePlan(row, JSON.parse(row.mapping) as ColumnMapping);
            if (plan.digest !== row.plan_digest) throw new StaleImportError();
            const importable = plan.summary.outcomes.new_payment + plan.summary.outcomes.status_update;
            if (importable === 0 && !plan.rows.some((r) => r.findings.length > 0)) {
              throw new AppError('conflict', 'There is nothing to import: every row is either rejected or already recorded.');
            }
            const result = applyPlan(ctx, row, plan);
            db.prepare(
              `UPDATE imports SET status = 'committed', committed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), committed_by_user_id = ?, result = ?
               WHERE id = ?`,
            ).run(ctx.actor.user.id, JSON.stringify(result), row.id);
            appendAudit(db, {
              organisationId: ctx.actor.organisationId,
              actor: auditActor(ctx),
              action: 'import.committed',
              entityType: 'import',
              entityId: row.id,
              outcome: 'succeeded',
              requestId: ctx.requestId,
              previousState: { status: 'validated', validationVersion },
              newState: {
                status: 'committed',
                newPayments: result.newPayments,
                statusObservations: result.statusObservations,
                findingsRecorded: result.findingsRecorded,
                casesOpened: result.casesOpened.map((c) => c.reference),
                casesUpdated: result.casesUpdated.map((c) => c.reference),
              },
            });
            return { import: toDetail(loadImport(ctx, importId)), alreadyCommitted: false };
          })
          .immediate();
      } catch (error) {
        if (error instanceof StaleImportError) {
          const revalidated = db
            .transaction(() => {
              const row = loadImport(ctx, importId);
              if (row.status !== 'validated' || !row.mapping) return row.validation_version;
              return storeValidation(ctx, row, JSON.parse(row.mapping) as ColumnMapping, computePlan(row, JSON.parse(row.mapping) as ColumnMapping));
            })
            .immediate();
          auditRejection(db, ctx, 'import.committed', 'import', importId, 'The preview was out of date. The import was re-validated and nothing was committed.', {
            confirmedValidationVersion: validationVersion,
            currentValidationVersion: revalidated,
          });
          throw new AppError(
            'conflict',
            'Records changed since this preview was produced. The file has been re-validated; review the updated results and confirm again. Nothing was committed.',
            { reason: 'stale_preview', validationVersion: revalidated },
          );
        }
        if (error instanceof AppError) {
          auditRejection(db, ctx, 'import.committed', 'import', importId, error.message);
          throw error;
        }
        rethrowBusy(error);
      }
    },

    async discard(ctx, importId) {
      assertRole(db, ctx, [...IMPORT_ROLES], 'import.discarded', 'import', importId);
      try {
        return db
          .transaction(() => {
            const row = loadImport(ctx, importId);
            if (row.status === 'committed' || row.status === 'discarded') {
              throw new AppError('conflict', `This import has already been ${row.status}.`);
            }
            db.prepare("UPDATE imports SET status = 'discarded', discarded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(importId);
            appendAudit(db, {
              organisationId: ctx.actor.organisationId,
              actor: auditActor(ctx),
              action: 'import.discarded',
              entityType: 'import',
              entityId: importId,
              outcome: 'succeeded',
              requestId: ctx.requestId,
              previousState: { status: row.status },
              newState: { status: 'discarded' },
            });
            return toDetail(loadImport(ctx, importId));
          })
          .immediate();
      } catch (error) {
        if (error instanceof AppError) auditRejection(db, ctx, 'import.discarded', 'import', importId, error.message);
        rethrowBusy(error);
      }
    },
  };
}
