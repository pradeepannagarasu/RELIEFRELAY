import { FINDING_INFO, type FindingCode } from '@shared/domain/findings';
import type { ImportSummary } from '@shared/api/contracts';
import type { RowIssue, RowIssueCode, RowOutcome } from '@shared/domain/imports';
import { sumMoney, type CurrencyCode } from '@shared/domain/money';
import type { PayoutItemStatus } from '@shared/domain/paypal';
import type { BatchOrigin } from '@shared/domain/types';
import { sha256Hex } from '../db/connection';
import { paymentFingerprint } from '../lib/paymentIdentity';
import type { NormalisedRow, RowValidation } from './validateRow';

export interface ExistingObservation {
  status: PayoutItemStatus;
  statusAt: string | null;
  errorCode: string | null;
  recordedAt: string;
}

export interface ExistingItem {
  id: string;
  paymentReference: string;
  batchId: string;
  batchReference: string;
  recipientReference: string;
  amountMinor: number;
  currency: CurrencyCode;
  fingerprint: string;
  provider: { status: PayoutItemStatus; providerItemId: string | null; providerTransactionId: string | null } | null;
  /** All imported observations, oldest first. */
  observations: ExistingObservation[];
}

export interface ExistingBatch {
  id: string;
  reference: string;
  origin: BatchOrigin;
  programme: string;
}

export interface ReconciliationContext {
  findItem(paymentReference: string): ExistingItem | undefined;
  findBatch(batchReference: string): ExistingBatch | undefined;
  itemsInBatch(batchId: string): ExistingItem[];
}

export interface PlannedFinding {
  code: FindingCode;
  /** self: the payment this row creates or matches. */
  target: 'self';
  detail: string;
  expected: unknown;
  actual: unknown;
  relatedRowNumbers: number[];
  relatedItemIds: string[];
  /** False for the earliest member of a possible-duplicate group, which is the reference payment. */
  opensCase: boolean;
}

export interface PlannedRow {
  rowNumber: number;
  outcome: RowOutcome;
  normalised: NormalisedRow | null;
  issues: RowIssue[];
  matchedItemId: string | null;
  fingerprint: string | null;
  findings: PlannedFinding[];
}

export interface ImportPlan {
  rows: PlannedRow[];
  digest: string;
  summary: ImportSummary;
}

const ROW_ISSUE_TO_FINDING: Partial<Record<RowIssueCode, FindingCode>> = {
  exception_status_recorded: 'exception_status_recorded',
  stale_unclaimed: 'stale_unclaimed',
  stale_pending: 'stale_pending',
  error_code_on_success: 'error_code_on_success',
  provider_status_conflict: 'provider_status_conflict',
  provider_reference_mismatch: 'provider_reference_mismatch',
};

const effectiveTime = (o: { statusAt: string | null; recordedAt?: string }) => Date.parse(o.statusAt ?? o.recordedAt ?? '');

function currentObservation(item: ExistingItem): ExistingObservation | undefined {
  return [...item.observations].sort((a, b) => effectiveTime(b) - effectiveTime(a)).at(0);
}

function identityOf(row: NormalisedRow) {
  return {
    batchReference: row.batchReference,
    paymentReference: row.paymentReference,
    recipientReference: row.recipientReference,
    receiverType: row.receiverType,
    receiver: row.receiver,
    amountMinor: row.amountMinor,
    currency: row.currency,
  };
}

function describeConflict(row: NormalisedRow, existing: ExistingItem): { fields: string[]; expected: Record<string, unknown>; actual: Record<string, unknown> } {
  const fields: string[] = [];
  const expected: Record<string, unknown> = {};
  const actual: Record<string, unknown> = {};
  const compare = (name: string, a: unknown, b: unknown) => {
    if (a !== b) {
      fields.push(name);
      expected[name] = a;
      actual[name] = b;
    }
  };
  compare('batch reference', existing.batchReference, row.batchReference);
  compare('recipient reference', existing.recipientReference, row.recipientReference);
  compare('amount (minor units)', existing.amountMinor, row.amountMinor);
  compare('currency', existing.currency, row.currency);
  if (fields.length === 0) fields.push('receiver');
  return { fields, expected, actual };
}

/**
 * Decides, deterministically, what committing each row would do. Nothing is written here; the same function
 * runs again inside the commit transaction and the commit is refused if the outcome has changed.
 */
export function planImport(rows: { rowNumber: number; validation: RowValidation }[], context: ReconciliationContext): ImportPlan {
  const referenceCounts = new Map<string, number>();
  for (const { validation } of rows) {
    if (validation.paymentReference) referenceCounts.set(validation.paymentReference, (referenceCounts.get(validation.paymentReference) ?? 0) + 1);
  }

  const planned: PlannedRow[] = rows.map(({ rowNumber, validation }) => {
    if (validation.blank) return { rowNumber, outcome: 'blank', normalised: null, issues: [], matchedItemId: null, fingerprint: null, findings: [] };
    const issues = [...validation.issues];
    const findings: PlannedFinding[] = [];
    const reject = (): PlannedRow => ({ rowNumber, outcome: 'rejected', normalised: validation.normalised, issues, matchedItemId: null, fingerprint: null, findings });

    if (validation.paymentReference && (referenceCounts.get(validation.paymentReference) ?? 0) > 1) {
      issues.push({
        code: 'duplicate_reference_in_file',
        severity: 'error',
        field: 'paymentReference',
        message: `Payment reference ${validation.paymentReference} appears more than once in this file. None of these rows will be imported.`,
      });
    }
    const row = validation.normalised;
    if (!row || issues.some((issue) => issue.severity === 'error')) return reject();

    const fingerprint = paymentFingerprint(identityOf(row));
    const existing = context.findItem(row.paymentReference);

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        const conflict = describeConflict(row, existing);
        issues.push({
          code: 'reference_conflict',
          severity: 'error',
          field: 'paymentReference',
          message: `Payment ${row.paymentReference} is already recorded with a different ${conflict.fields.join(', ')}. The existing record is kept; this row will not be imported.`,
        });
        return {
          rowNumber,
          outcome: 'rejected',
          normalised: row,
          issues,
          matchedItemId: existing.id,
          fingerprint,
          findings: [
            {
              code: 'reference_conflict',
              target: 'self',
              detail: `An import contained payment ${row.paymentReference} with a different ${conflict.fields.join(', ')}. The import row was rejected.`,
              expected: conflict.expected,
              actual: conflict.actual,
              relatedRowNumbers: [],
              relatedItemIds: [],
              opensCase: true,
            },
          ],
        };
      }

      if (existing.provider && row.recordedStatus && row.recordedStatus !== existing.provider.status) {
        issues.push({
          code: 'provider_status_conflict',
          severity: 'warning',
          field: 'recordedStatus',
          message: `Recorded as ${row.recordedStatus}, but the provider reports ${existing.provider.status}. The provider status stays authoritative.`,
        });
      }
      const mismatched = [
        row.providerItemId && existing.provider?.providerItemId && row.providerItemId !== existing.provider.providerItemId ? 'item' : null,
        row.providerTransactionId && existing.provider?.providerTransactionId && row.providerTransactionId !== existing.provider.providerTransactionId
          ? 'transaction'
          : null,
      ].filter(Boolean);
      if (mismatched.length > 0) {
        issues.push({
          code: 'provider_reference_mismatch',
          severity: 'warning',
          field: mismatched[0] === 'item' ? 'providerItemId' : 'providerTransactionId',
          message: `The provider ${mismatched.join(' and ')} ID in this row does not match the provider record.`,
        });
      }

      const alreadyObserved =
        row.recordedStatus === null ||
        existing.observations.some((o) => o.status === row.recordedStatus && o.statusAt === row.statusAt && o.errorCode === row.errorCode);
      if (alreadyObserved) {
        return { rowNumber, outcome: 'unchanged', normalised: row, issues, matchedItemId: existing.id, fingerprint, findings: [] };
      }

      const current = currentObservation(existing);
      if (current && row.statusAt && Date.parse(row.statusAt) < effectiveTime(current)) {
        issues.push({
          code: 'older_than_current_status',
          severity: 'info',
          field: 'statusDate',
          message: 'This status is older than the current imported status. It is added to the history without changing the current status.',
        });
      }
      if (current && current.status !== row.recordedStatus) {
        findings.push({
          code: 'imported_status_changed',
          target: 'self',
          detail: `Imported status changed from ${current.status} to ${row.recordedStatus}. The earlier observation is kept.`,
          expected: { status: current.status },
          actual: { status: row.recordedStatus },
          relatedRowNumbers: [],
          relatedItemIds: [],
          opensCase: false,
        });
      }
      return { rowNumber, outcome: 'status_update', normalised: row, issues, matchedItemId: existing.id, fingerprint, findings };
    }

    const batch = context.findBatch(row.batchReference);
    if (batch && batch.origin === 'provider_submission') {
      issues.push({
        code: 'batch_closed_to_import',
        severity: 'error',
        field: 'batchReference',
        message: `Batch ${row.batchReference} was submitted to the provider through ReliefRelay. New payments cannot be added to it by import.`,
      });
      return reject();
    }
    return { rowNumber, outcome: 'new_payment', normalised: row, issues, matchedItemId: null, fingerprint, findings };
  });

  // Possible duplicates: same batch, recipient reference, amount and currency, but different payment references.
  const groups = new Map<string, PlannedRow[]>();
  for (const row of planned) {
    if (row.outcome !== 'new_payment' || !row.normalised) continue;
    const n = row.normalised;
    const key = JSON.stringify([n.batchReference, n.recipientReference, n.amountMinor, n.currency]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const [key, members] of groups) {
    const [batchReference, recipientReference, amountMinor, currency] = JSON.parse(key) as [string, string, number, string];
    const batch = context.findBatch(batchReference);
    const existingMatches = batch
      ? context
          .itemsInBatch(batch.id)
          .filter((item) => item.recipientReference === recipientReference && item.amountMinor === amountMinor && item.currency === currency)
      : [];
    if (members.length + existingMatches.length < 2) continue;
    members.forEach((member, index) => {
      const others = members.filter((m) => m !== member);
      member.issues.push({
        code: 'possible_duplicate_payment',
        severity: 'warning',
        field: 'recipientReference',
        message: `Same recipient reference, amount and currency as ${[
          ...others.map((o) => `row ${o.rowNumber}`),
          ...existingMatches.map((e) => `existing payment ${e.paymentReference}`),
        ].join(', ')} in batch ${batchReference}. It will be imported and flagged for confirmation; nothing is merged, deleted or paid.`,
      });
      member.findings.push({
        code: 'possible_duplicate_payment',
        target: 'self',
        detail: `Same recipient reference, amount and currency as ${others.length + existingMatches.length} other payment(s) in batch ${batchReference}.`,
        expected: null,
        actual: { batchReference, recipientReference, amountMinor, currency },
        relatedRowNumbers: others.map((o) => o.rowNumber),
        relatedItemIds: existingMatches.map((e) => e.id),
        opensCase: existingMatches.length > 0 || index > 0,
      });
    });
  }

  // Programme names should be consistent within a batch.
  const programmeByBatch = new Map<string, string>();
  for (const row of planned) {
    if (row.outcome !== 'new_payment' || !row.normalised?.programme) continue;
    const n = row.normalised;
    const existingProgramme = context.findBatch(n.batchReference)?.programme ?? programmeByBatch.get(n.batchReference);
    if (existingProgramme === undefined) programmeByBatch.set(n.batchReference, n.programme!);
    else if (existingProgramme !== n.programme) {
      row.issues.push({
        code: 'inconsistent_programme',
        severity: 'warning',
        field: 'programme',
        message: `Batch ${n.batchReference} is recorded with programme “${existingProgramme}”. This row’s programme is ignored.`,
      });
    }
  }

  for (const row of planned) {
    if (row.outcome !== 'new_payment' && row.outcome !== 'status_update') continue;
    for (const issue of row.issues) {
      const code = ROW_ISSUE_TO_FINDING[issue.code];
      if (!code || row.findings.some((f) => f.code === code)) continue;
      row.findings.push({
        code,
        target: 'self',
        detail: issue.message,
        expected: null,
        actual: { status: row.normalised?.recordedStatus ?? null, statusAt: row.normalised?.statusAt ?? null, errorCode: row.normalised?.errorCode ?? null },
        relatedRowNumbers: [],
        relatedItemIds: [],
        opensCase: FINDING_INFO[code].opensCase !== null,
      });
    }
  }

  return { rows: planned, digest: digestOf(planned), summary: summarise(planned, context) };
}

function digestOf(rows: PlannedRow[]): string {
  return sha256Hex(
    JSON.stringify(
      rows.map((r) => [
        r.rowNumber,
        r.outcome,
        r.matchedItemId,
        r.fingerprint,
        r.issues.map((i) => i.code).sort(),
        r.findings.map((f) => [f.code, f.opensCase, f.relatedItemIds]).sort(),
      ]),
    ),
  );
}

function summarise(rows: PlannedRow[], context: ReconciliationContext): ImportSummary {
  const outcomes: ImportSummary['outcomes'] = { new_payment: 0, status_update: 0, unchanged: 0, rejected: 0, blank: 0 };
  const issueCounts: ImportSummary['issueCounts'] = {};
  let rowsWithWarnings = 0;
  for (const row of rows) {
    outcomes[row.outcome] += 1;
    for (const code of new Set(row.issues.map((i) => i.code))) issueCounts[code] = (issueCounts[code] ?? 0) + 1;
    if (row.outcome !== 'rejected' && row.issues.some((i) => i.severity === 'warning')) rowsWithWarnings += 1;
  }
  const newRows = rows.filter((r) => r.outcome === 'new_payment' && r.normalised);
  const newBatchReferences = [...new Set(newRows.map((r) => r.normalised!.batchReference))].filter((ref) => !context.findBatch(ref)).sort();
  return {
    dataRows: rows.length - outcomes.blank,
    outcomes,
    issueCounts,
    rowsWithWarnings,
    newBatchReferences,
    newPaymentValue: sumMoney(newRows.map((r) => ({ currency: r.normalised!.currency, minor: r.normalised!.amountMinor }))),
    rowsRaisingFindings: rows.filter((r) => r.findings.some((f) => f.opensCase)).length,
  };
}
