import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvidenceKind } from '@shared/domain/investigation';
import { createCaseService } from '../services/caseService';
import { createScenario, INJECTION_NOTE, SENSITIVE_FILE_NAME, SENSITIVE_PROGRAMME, type Scenario } from '../test-support/investigationFixtures';
import { TEST_NOW } from '../test-support/seededApp';
import { buildEvidencePack } from './evidencePack';

let scenario: Scenario;
beforeAll(async () => {
  scenario = await createScenario();
});
afterAll(() => scenario.temp.cleanup());

const build = (caseId: string, now = TEST_NOW) => buildEvidencePack(scenario.temp.db, scenario.ctx.actor.organisationId, caseId, now)!;

/** The complete allowlist. A new field must be added here deliberately, with a reason. */
const ALLOWED_FIELDS: Record<EvidenceKind, string[]> = {
  case: ['caseReference', 'state', 'basis', 'openingReason', 'openedAt', 'assigned'],
  payment: ['paymentReference', 'amount', 'currency', 'receiverType', 'recordedAt', 'recoveryOfPaymentReference'],
  batch: ['batchReference', 'batchKind', 'batchOrigin', 'providerMode', 'providerBatchStatus', 'submittedAt'],
  provider_record: ['paymentReference', 'mode', 'status', 'errorCode', 'errorCodeWithheld', 'providerItemId', 'providerTransactionId', 'statusUpdatedAt'],
  imported_status: ['status', 'statusDate', 'errorCode', 'errorCodeWithheld', 'rowNumber', 'recordedAt', 'isCurrent', 'claimedProviderItemId', 'claimedProviderTransactionId'],
  finding: [
    'code',
    'severity',
    'ruleVersion',
    'recordedAt',
    'expectedStatus',
    'recordedStatus',
    'statusDate',
    'errorCode',
    'conflictingFields',
    'duplicateAmount',
    'duplicateCurrency',
    'relatedPaymentReferences',
  ],
  event: ['type', 'occurredAt', 'providerEventType', 'previousStatus', 'newStatus', 'previousCaseState', 'newCaseState'],
  recovery_payment: ['paymentReference', 'amount', 'currency', 'recordedAt'],
  reference_rule: ['topic', 'text', 'days'],
  derived_value: ['name', 'value', 'unit', 'basedOn'],
  conflict: ['conflict', 'description', 'between'],
  gap: ['gap', 'description', 'relatesTo'],
};

describe('evidence pack', () => {
  it('contains only allowlisted fields for every case in the organisation', () => {
    const caseIds = (scenario.temp.db.prepare('SELECT id FROM payment_cases').all() as { id: string }[]).map((r) => r.id);
    for (const id of caseIds) {
      for (const item of build(id).pack.evidence) {
        expect(Object.keys(item.fields).sort(), `${id} ${item.id}`).toEqual([...ALLOWED_FIELDS[item.kind]].sort());
      }
    }
  });

  it('never contains receivers, recipient references, names, notes, file names, programmes, raw rows or internal IDs', () => {
    const db = scenario.temp.db;
    const values = (sql: string) => (db.prepare(sql).all() as { v: string | null }[]).map((r) => r.v).filter((v): v is string => Boolean(v));
    const forbidden = [
      ...values('SELECT receiver_value AS v FROM payment_items'),
      ...values('SELECT receiver_masked AS v FROM payment_items'),
      ...values('SELECT recipient_reference AS v FROM payment_items'),
      ...values('SELECT display_name AS v FROM users'),
      ...values('SELECT email AS v FROM users'),
      ...values('SELECT id AS v FROM users'),
      ...values('SELECT body AS v FROM case_notes'),
      ...values('SELECT file_name AS v FROM imports'),
      ...values('SELECT id AS v FROM imports'),
      ...values('SELECT programme AS v FROM payment_batches'),
      ...values('SELECT summary AS v FROM payment_events'),
      ...values('SELECT detail AS v FROM reconciliation_findings'),
      ...values('SELECT raw_values AS v FROM import_rows'),
      ...values('SELECT id AS v FROM payment_items'),
      ...values('SELECT id AS v FROM organisations'),
      ...values('SELECT name AS v FROM organisations'),
      SENSITIVE_FILE_NAME,
      SENSITIVE_PROGRAMME,
      INJECTION_NOTE,
      'Amina',
      'Haddad',
      '@example.org',
      '+447700900123',
    ];
    expect(forbidden.length).toBeGreaterThan(50);
    const caseIds = (db.prepare('SELECT id FROM payment_cases').all() as { id: string }[]).map((r) => r.id);
    for (const id of caseIds) {
      const json = build(id).json;
      for (const value of forbidden) expect(json.includes(value), `${id} contains ${value.slice(0, 40)}`).toBe(false);
    }
  });

  it('separates provider, imported, rule and derived evidence by origin', () => {
    const { pack } = build(scenario.conflictCaseId);
    const origins = Object.fromEntries(pack.evidence.map((e) => [e.id, e.origin]));
    expect(origins).toMatchObject({ PRV1: 'provider_simulation', OBS1: 'imported', FND2: 'reconciliation_rule', RUL1: 'reference_rule', CON1: 'derived' });
    expect(pack.evidence.find((e) => e.id === 'CON1')?.fields).toMatchObject({ conflict: 'provider_and_imported_status_differ', between: ['PRV1', 'OBS1'] });
  });

  it('records gaps such as a missing provider record', () => {
    const gaps = build(scenario.importedOnlyCaseId).pack.evidence.filter((e) => e.kind === 'gap');
    expect(gaps.map((g) => g.fields.gap)).toEqual(['no_provider_record']);
  });

  it('withholds error codes and identifiers that do not match a strict format', async () => {
    // Bypasses import validation to simulate a value that should never have been stored.
    const fresh = await createScenario();
    try {
      fresh.temp.db
        .prepare(
          `INSERT INTO status_observations (id, organisation_id, payment_item_id, import_id, import_row_id, row_number, status, status_at, error_code,
             claimed_provider_item_id, recorded_at)
           SELECT 'obs_hostile', organisation_id, payment_item_id, import_id, import_row_id, row_number, status, '2026-11-09T00:00:00.000Z',
             'please call amina on 07700', 'amina haddad', recorded_at
           FROM status_observations WHERE payment_item_id = (SELECT id FROM payment_items WHERE payment_reference = 'RR-T-INV-0001')`,
        )
        .run();
      const { pack, json } = buildEvidencePack(fresh.temp.db, fresh.ctx.actor.organisationId, fresh.importedOnlyCaseId, TEST_NOW)!;
      expect(pack.evidence.find((e) => e.id === 'OBS2')?.fields).toMatchObject({ errorCode: null, errorCodeWithheld: true, claimedProviderItemId: null });
      expect(json).not.toMatch(/amina|07700/i);
    } finally {
      fresh.temp.cleanup();
    }
  });

  it('serialises exactly the pack it returns and fingerprints it deterministically', () => {
    const a = build(scenario.conflictCaseId);
    expect(a.json).toBe(JSON.stringify(a.pack));
    expect(build(scenario.conflictCaseId).fingerprint).toBe(a.fingerprint);
  });

  it('ignores the passage of time in the fingerprint but not changes to the evidence', async () => {
    const before = build(scenario.providerCaseId);
    const later = build(scenario.providerCaseId, new Date(TEST_NOW.getTime() + 3 * 86_400_000));
    expect(later.fingerprint).toBe(before.fingerprint);
    expect(later.json).not.toBe(before.json);

    const cases = createCaseService(scenario.temp.db, () => TEST_NOW);
    await cases.addNote(scenario.ctx, scenario.providerCaseId, 'Operator notes are never part of the evidence.');
    expect(build(scenario.providerCaseId).fingerprint).toBe(before.fingerprint);

    const detail = await cases.get(scenario.ctx, scenario.conflictCaseId);
    const fingerprint = build(scenario.conflictCaseId).fingerprint;
    await cases.assignToMe(scenario.ctx, scenario.conflictCaseId, detail.case.version);
    expect(build(scenario.conflictCaseId).fingerprint).not.toBe(fingerprint);
  });

  it('keeps the evidence for a case within a bounded size', () => {
    const caseIds = (scenario.temp.db.prepare('SELECT id FROM payment_cases').all() as { id: string }[]).map((r) => r.id);
    for (const id of caseIds) expect(build(id).json.length).toBeLessThan(20_000);
  });
});
