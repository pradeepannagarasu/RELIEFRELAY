import { FINDING_CODES, FINDING_INFO, STALE_PENDING_DAYS, type FindingCode } from '@shared/domain/findings';
import {
  EVIDENCE_PACK_VERSION,
  WITHHELD_CATEGORIES,
  type EvidenceItem,
  type EvidenceKind,
  type EvidenceOrigin,
  type EvidencePack,
  type EvidenceValue,
} from '@shared/domain/investigation';
import { PAYOUT_ITEM_STATUSES, PAYOUT_ITEM_STATUS_INFO, UNCLAIMED_AUTO_RETURN_DAYS, type PayoutItemStatus } from '@shared/domain/paypal';
import { CASE_STATES, type CaseState, type EventSource, type PaymentEventType } from '@shared/domain/types';
import { sha256Hex, type Db } from '../db/connection';
import type { BatchRow, CaseRow, EventRow, ItemRow, ObservationRow, ProviderRow } from '../repositories/sqlite/readModel';

/**
 * Builds the evidence pack for one case from an explicit allowlist of normalised fields.
 *
 * Nothing is copied from free text: finding details, event summaries, notes, raw CSV cells, file names, programme
 * names, recipient references, receivers and user names are never read into the pack. Identifiers and error codes
 * are included only when they match a strict format; anything else is withheld rather than passed through.
 */

export interface EvidenceSource {
  type: 'case' | 'payment' | 'batch' | 'provider_record' | 'observation' | 'finding' | 'event';
  id: string;
}

export interface BuiltEvidencePack {
  pack: EvidencePack;
  /** The exact text sent to the model and stored with the attempt. */
  json: string;
  /** SHA-256 of the evidence, excluding values that change only with the passage of time. */
  fingerprint: string;
  /** Maps evidence IDs to the ReliefRelay records they came from. Never sent to the model. */
  sources: Record<string, EvidenceSource>;
}

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROVIDER_ID = /^[A-Za-z0-9-]{1,64}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const DAY_MS = 86_400_000;
const MAX_EVENTS = 25;

const status = (value: unknown): PayoutItemStatus | null =>
  typeof value === 'string' && (PAYOUT_ITEM_STATUSES as readonly string[]).includes(value) ? (value as PayoutItemStatus) : null;
const caseState = (value: unknown): CaseState | null =>
  typeof value === 'string' && (CASE_STATES as readonly string[]).includes(value) ? (value as CaseState) : null;
const reference = (value: unknown) => (typeof value === 'string' && REFERENCE.test(value) ? value : null);
const providerId = (value: unknown) => (typeof value === 'string' && PROVIDER_ID.test(value) ? value : null);
const errorCode = (value: unknown) => (typeof value === 'string' && ERROR_CODE.test(value) ? value : null);
const timestamp = (value: unknown) => (typeof value === 'string' && ISO.test(value) && !Number.isNaN(Date.parse(value)) ? value : null);
const amount = (minor: number) => (minor / 100).toFixed(2);

const EVENT_ORIGIN: Record<EventSource, EvidenceOrigin> = {
  simulation: 'provider_simulation',
  sandbox: 'provider_sandbox',
  import: 'imported',
  operator: 'reliefrelay_record',
  system: 'reliefrelay_record',
};

/** Finding fields whose names may be listed (never their values) when an import conflicted with a stored payment. */
const CONFLICT_FIELD_NAMES: Record<string, string> = {
  'batch reference': 'batchReference',
  'recipient reference': 'recipientReference',
  'amount (minor units)': 'amount',
  currency: 'currency',
};

interface FindingRow {
  id: string;
  code: string;
  severity: string;
  expected: string | null;
  actual: string | null;
  related_item_ids: string;
  rule_version: number;
  recorded_at: string;
}

const parseObject = (json: string | null): Record<string, unknown> => {
  if (!json) return {};
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const wholeDays = (from: string, to: Date) => Math.floor((to.getTime() - Date.parse(from)) / DAY_MS);

export function buildEvidencePack(db: Db, organisationId: string, caseId: string, now: Date): BuiltEvidencePack | null {
  const caseRow = db.prepare('SELECT * FROM payment_cases WHERE id = ? AND organisation_id = ?').get(caseId, organisationId) as CaseRow | undefined;
  if (!caseRow) return null;
  const item = db.prepare('SELECT * FROM payment_items WHERE id = ?').get(caseRow.payment_item_id) as ItemRow;
  const batch = db.prepare('SELECT * FROM payment_batches WHERE id = ?').get(item.batch_id) as BatchRow;
  const references = new Map(
    (db.prepare('SELECT id, payment_reference FROM payment_items WHERE organisation_id = ?').all(organisationId) as { id: string; payment_reference: string }[]).map(
      (r) => [r.id, r.payment_reference],
    ),
  );
  const providerFor = db.prepare('SELECT * FROM provider_transactions WHERE payment_item_id = ?');

  const evidence: EvidenceItem[] = [];
  const sources: Record<string, EvidenceSource> = {};
  const timeRelative = new Set<string>();
  const counters = new Map<string, number>();
  const add = (prefix: string, kind: EvidenceKind, origin: EvidenceOrigin, fields: Record<string, EvidenceValue>, source?: EvidenceSource): string => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    const id = `${prefix}${n}`;
    evidence.push({ id, kind, origin, fields });
    if (source) sources[id] = source;
    return id;
  };

  const caseId1 = add(
    'CASE',
    'case',
    'reliefrelay_record',
    {
      caseReference: reference(caseRow.reference),
      state: caseRow.state,
      basis: caseRow.basis,
      openingReason: caseRow.opening_reason === 'provider_exception' || (FINDING_CODES as readonly string[]).includes(caseRow.opening_reason) ? caseRow.opening_reason : null,
      openedAt: timestamp(caseRow.opened_at),
      assigned: caseRow.assignee_user_id !== null,
    },
    { type: 'case', id: caseRow.id },
  );

  const paymentId = add(
    'PAY',
    'payment',
    'reliefrelay_record',
    {
      paymentReference: reference(item.payment_reference),
      amount: amount(item.amount_minor),
      currency: item.currency,
      receiverType: item.receiver_type,
      recordedAt: timestamp(item.created_at),
      recoveryOfPaymentReference: item.recovery_of_item_id ? reference(references.get(item.recovery_of_item_id)) : null,
    },
    { type: 'payment', id: item.id },
  );

  add(
    'BATCH',
    'batch',
    'reliefrelay_record',
    {
      batchReference: reference(batch.reference),
      batchKind: batch.kind,
      batchOrigin: batch.origin,
      providerMode: batch.provider_mode,
      providerBatchStatus: batch.provider_status,
      submittedAt: timestamp(batch.submitted_at),
    },
    { type: 'batch', id: batch.id },
  );

  const providerItem = (row: ProviderRow, paymentReference: string | null) => {
    const code = errorCode(row.error_code);
    return add(
      'PRV',
      'provider_record',
      row.mode === 'sandbox' ? 'provider_sandbox' : 'provider_simulation',
      {
        paymentReference,
        mode: row.mode,
        status: row.status,
        errorCode: code,
        errorCodeWithheld: row.error_code !== null && code === null,
        providerItemId: providerId(row.provider_item_id),
        providerTransactionId: providerId(row.provider_transaction_id),
        statusUpdatedAt: timestamp(row.status_updated_at),
      },
      { type: 'provider_record', id: row.payment_item_id },
    );
  };

  const provider = providerFor.get(item.id) as ProviderRow | undefined;
  const providerEvidenceId = provider ? providerItem(provider, reference(item.payment_reference)) : null;

  const observations = db.prepare('SELECT * FROM status_observations WHERE payment_item_id = ? ORDER BY seq').all(item.id) as ObservationRow[];
  const effective = (o: ObservationRow) => Date.parse(o.status_at ?? o.recorded_at);
  const current = [...observations].sort((a, b) => effective(b) - effective(a) || b.seq - a.seq)[0];
  const observationIds = new Map<string, string>();
  for (const o of observations) {
    const code = errorCode(o.error_code);
    observationIds.set(
      o.id,
      add(
        'OBS',
        'imported_status',
        'imported',
        {
          status: o.status,
          statusDate: timestamp(o.status_at),
          errorCode: code,
          errorCodeWithheld: o.error_code !== null && code === null,
          rowNumber: o.row_number,
          recordedAt: timestamp(o.recorded_at),
          isCurrent: o.id === current?.id,
          claimedProviderItemId: providerId(o.claimed_provider_item_id),
          claimedProviderTransactionId: providerId(o.claimed_provider_transaction_id),
        },
        { type: 'observation', id: o.id },
      ),
    );
  }
  const currentObservationId = current ? (observationIds.get(current.id) ?? null) : null;

  const findingRows = db
    .prepare('SELECT id, code, severity, expected, actual, related_item_ids, rule_version, recorded_at FROM reconciliation_findings WHERE payment_item_id = ? ORDER BY recorded_at, rowid')
    .all(item.id) as FindingRow[];
  const findingIds: { id: string; code: FindingCode }[] = [];
  for (const f of findingRows) {
    if (!(FINDING_CODES as readonly string[]).includes(f.code)) continue;
    const code = f.code as FindingCode;
    const expected = parseObject(f.expected);
    const actual = parseObject(f.actual);
    let related: unknown = [];
    try {
      related = JSON.parse(f.related_item_ids);
    } catch {
      related = [];
    }
    const fields: Record<string, EvidenceValue> = {
      code,
      severity: FINDING_INFO[code].severity,
      ruleVersion: f.rule_version,
      recordedAt: timestamp(f.recorded_at),
      expectedStatus: status(expected.status),
      recordedStatus: status(actual.status),
      statusDate: timestamp(actual.statusAt),
      errorCode: errorCode(actual.errorCode),
      conflictingFields:
        code === 'reference_conflict'
          ? Object.keys(expected)
              .map((k) => CONFLICT_FIELD_NAMES[k])
              .filter((k): k is string => k !== undefined)
          : [],
      duplicateAmount: code === 'possible_duplicate_payment' && typeof actual.amountMinor === 'number' ? amount(actual.amountMinor) : null,
      duplicateCurrency: code === 'possible_duplicate_payment' && typeof actual.currency === 'string' && /^[A-Z]{3}$/.test(actual.currency) ? actual.currency : null,
      relatedPaymentReferences: (Array.isArray(related) ? related : [])
        .map((id) => (typeof id === 'string' ? reference(references.get(id)) : null))
        .filter((r): r is string => r !== null),
    };
    findingIds.push({ id: add('FND', 'finding', 'reconciliation_rule', fields, { type: 'finding', id: f.id }), code });
  }

  const recoveries = db.prepare('SELECT * FROM payment_items WHERE recovery_of_item_id = ? ORDER BY created_at').all(item.id) as ItemRow[];
  for (const r of recoveries) {
    add(
      'REC',
      'recovery_payment',
      'reliefrelay_record',
      { paymentReference: reference(r.payment_reference), amount: amount(r.amount_minor), currency: r.currency, recordedAt: timestamp(r.created_at) },
      { type: 'payment', id: r.id },
    );
    const recoveryProvider = providerFor.get(r.id) as ProviderRow | undefined;
    if (recoveryProvider) providerItem(recoveryProvider, reference(r.payment_reference));
  }

  const events = (
    db.prepare('SELECT * FROM payment_events WHERE payment_item_id = ? OR case_id = ? ORDER BY occurred_at, recorded_at, rowid').all(item.id, caseRow.id) as EventRow[]
  ).slice(-MAX_EVENTS);
  for (const e of events) {
    add(
      'EVT',
      'event',
      EVENT_ORIGIN[e.source],
      {
        type: e.type satisfies PaymentEventType,
        occurredAt: timestamp(e.occurred_at),
        providerEventType: e.provider_event_type,
        previousStatus: status(e.previous_status),
        newStatus: status(e.new_status),
        previousCaseState: caseState(e.previous_case_state),
        newCaseState: caseState(e.new_case_state),
      },
      { type: 'event', id: e.id },
    );
  }

  /* Reference rules: fixed ReliefRelay text, never data from the organisation. */
  const statusesPresent = new Set<PayoutItemStatus>();
  for (const e of evidence) {
    for (const key of ['status', 'previousStatus', 'newStatus', 'expectedStatus', 'recordedStatus']) {
      const s = status(e.fields[key]);
      if (s) statusesPresent.add(s);
    }
  }
  add('RUL', 'reference_rule', 'reference_rule', {
    topic: 'status_authority',
    text: 'Provider records are authoritative for payment status. Imported records are the organisation’s own exports and are not confirmed by the provider.',
    days: null,
  });
  const modes = new Set(evidence.filter((e) => e.kind === 'provider_record').map((e) => e.fields.mode));
  if (modes.has('simulation') || batch.provider_mode === 'simulation') {
    add('RUL', 'reference_rule', 'reference_rule', {
      topic: 'simulation_mode',
      text: 'Simulation mode: provider records and provider events for this payment are synthetic. No request was sent to PayPal and no money moved.',
      days: null,
    });
  }
  if (modes.has('sandbox') || batch.provider_mode === 'sandbox' || evidence.some((e) => e.origin === 'provider_sandbox')) {
    add('RUL', 'reference_rule', 'reference_rule', {
      topic: 'sandbox_mode',
      text: 'PayPal Sandbox: provider records marked sandbox come from PayPal’s test environment and involve test money only. A Sandbox status does not show that a real recipient was paid.',
      days: null,
    });
  }
  for (const s of PAYOUT_ITEM_STATUSES) {
    if (!statusesPresent.has(s)) continue;
    add('RUL', 'reference_rule', 'reference_rule', { topic: `status_${s}`, text: `${s}: ${PAYOUT_ITEM_STATUS_INFO[s].description}`, days: null });
  }
  if (statusesPresent.has('UNCLAIMED')) {
    add('RUL', 'reference_rule', 'reference_rule', {
      topic: 'unclaimed_auto_return',
      text: `PayPal returns unclaimed payouts to the sender if they are not claimed within ${UNCLAIMED_AUTO_RETURN_DAYS} days.`,
      days: UNCLAIMED_AUTO_RETURN_DAYS,
    });
  }
  if (provider?.status === 'PENDING' || current?.status === 'PENDING') {
    add('RUL', 'reference_rule', 'reference_rule', {
      topic: 'stale_pending',
      text: `ReliefRelay flags PENDING for longer than ${STALE_PENDING_DAYS} days as unusual.`,
      days: STALE_PENDING_DAYS,
    });
  }

  /* Values calculated by ReliefRelay, so the model never has to do date arithmetic. */
  const derived = (name: string, value: string | number, unit: 'days' | 'date', basedOn: string[], relative: boolean) => {
    const id = add('DRV', 'derived_value', 'derived', { name, value, unit, basedOn });
    if (relative) timeRelative.add(id);
  };
  if (provider && providerEvidenceId) {
    derived('daysSinceProviderStatusUpdate', wholeDays(provider.status_updated_at, now), 'days', [providerEvidenceId], true);
    if (provider.status === 'UNCLAIMED') {
      const due = new Date(Date.parse(provider.status_updated_at) + UNCLAIMED_AUTO_RETURN_DAYS * DAY_MS).toISOString();
      derived('expectedAutoReturnDate', due.slice(0, 10), 'date', [providerEvidenceId], false);
    }
  }
  if (current?.status_at && currentObservationId) {
    derived('daysSinceImportedStatusDate', wholeDays(current.status_at, now), 'days', [currentObservationId], true);
  }
  derived('daysSinceCaseOpened', wholeDays(caseRow.opened_at, now), 'days', [caseId1], true);

  /* Conflicts and gaps, detected deterministically. The output must acknowledge every one of them. */
  const conflict = (name: string, description: string, between: string[]) => add('CON', 'conflict', 'derived', { conflict: name, description, between });
  const gap = (name: string, description: string, relatesTo: string[]) => add('GAP', 'gap', 'derived', { gap: name, description, relatesTo });

  if (provider && providerEvidenceId && current && currentObservationId && current.status !== provider.status) {
    conflict(
      'provider_and_imported_status_differ',
      `The provider record shows ${provider.status}; the current imported record shows ${current.status}.`,
      [providerEvidenceId, currentObservationId],
    );
  }
  const distinctImported = [...new Set(observations.map((o) => o.status))];
  if (distinctImported.length > 1) {
    conflict(
      'imported_statuses_differ',
      `Imported records for this payment show different statuses over time: ${distinctImported.join(', ')}.`,
      observations.map((o) => observationIds.get(o.id)!),
    );
  }
  if (current && currentObservationId && current.status === 'SUCCESS' && current.error_code) {
    conflict('imported_success_with_error_code', 'The current imported record shows SUCCESS together with an error code.', [currentObservationId]);
  }
  if (provider && providerEvidenceId && provider.status === 'SUCCESS' && provider.error_code) {
    conflict('provider_success_with_error_code', 'The provider record shows SUCCESS together with an error code.', [providerEvidenceId]);
  }
  if (provider && providerEvidenceId) {
    for (const o of observations) {
      const mismatch =
        (o.claimed_provider_item_id && provider.provider_item_id && o.claimed_provider_item_id !== provider.provider_item_id) ||
        (o.claimed_provider_transaction_id && provider.provider_transaction_id && o.claimed_provider_transaction_id !== provider.provider_transaction_id);
      if (mismatch) {
        conflict('provider_reference_mismatch', 'An imported record gives provider IDs that differ from the provider record.', [providerEvidenceId, observationIds.get(o.id)!]);
      }
    }
  }
  for (const f of findingIds.filter((f) => f.code === 'reference_conflict')) {
    conflict('import_conflicts_with_stored_payment', 'An import contained this payment reference with different payment details. The stored record was kept.', [f.id, paymentId]);
  }

  if (!provider) {
    gap('no_provider_record', 'There is no provider record for this payment, so its delivery has not been confirmed by a provider.', [paymentId]);
  }
  if (current && currentObservationId && !current.status_at) {
    gap('imported_status_date_missing', 'The current imported record does not give a status date.', [currentObservationId]);
  }
  if (provider && providerEvidenceId && ['PENDING', 'ONHOLD', 'UNCLAIMED'].includes(provider.status)) {
    gap('provider_outcome_not_final', `The provider status ${provider.status} is not a final outcome.`, [providerEvidenceId]);
  }
  const reported = provider ?? current;
  if (reported && (reported.status === 'FAILED' || reported.status === 'BLOCKED') && !reported.error_code) {
    gap('no_error_code', 'The record shows an undelivered status without an error code, so no failure reason is recorded.', [
      (provider ? providerEvidenceId : currentObservationId)!,
    ]);
  }
  for (const f of findingIds.filter((f) => f.code === 'possible_duplicate_payment')) {
    gap('duplicate_intent_unknown', 'The records cannot show whether payments with the same recipient reference, amount and currency were intended.', [f.id]);
  }

  const pack: EvidencePack = {
    packVersion: EVIDENCE_PACK_VERSION,
    asOf: now.toISOString(),
    withheld: [...WITHHELD_CATEGORIES],
    evidence,
  };
  const json = JSON.stringify(pack);
  const fingerprint = sha256Hex(JSON.stringify({ packVersion: pack.packVersion, evidence: evidence.filter((e) => !timeRelative.has(e.id)) }));
  return { pack, json, fingerprint, sources };
}
