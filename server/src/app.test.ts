import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  CaseDetail,
  CaseListResponse,
  CommitImportResponse,
  ImportDetail,
  ImportListResponse,
  ImportRowsResponse,
  SessionResponse,
  UploadImportResponse,
} from '@shared/api/contracts';
import type { Overview } from '@shared/domain/overview';
import { verifyAuditChain } from './audit/auditLog';
import { loadConfig } from './config/env';
import { createSeededDatabase, startApp, TEST_NOW, type RunningApp } from './test-support/seededApp';
import type { TempDatabase } from './test-support/tempDb';

let temp: TempDatabase;
let app: RunningApp;
let viewer: RunningApp;

beforeAll(async () => {
  temp = createSeededDatabase();
  app = await startApp(temp, undefined, { OPENAI_API_KEY: 'sk-test-should-never-leak' });
  viewer = await startApp(temp, 'usr_tomas');
});

afterAll(async () => {
  await app.close();
  await viewer.close();
  temp.cleanup();
});

const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const upload = (base: string, fileName: string, text: string) =>
  fetch(`${base}/imports?fileName=${encodeURIComponent(fileName)}`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text });

async function uploadAndValidate(fileName: string, text: string): Promise<ImportDetail> {
  const res = await upload(app.baseUrl, fileName, text);
  expect(res.status).toBe(201);
  const { import: created } = (await res.json()) as UploadImportResponse;
  const mapped = await fetch(`${app.baseUrl}/imports/${created.id}/mapping`, { ...json({ mapping: created.suggestedMapping }), method: 'PUT' });
  expect(mapped.status).toBe(200);
  return (await mapped.json()) as ImportDetail;
}

const HEADER = 'payment_reference,batch_reference,recipient_reference,amount,currency,receiver_type,receiver,status,status_date';
const line = (ref: string, amount = '90.00', status = 'SUCCESS') =>
  `${ref},RR-B-2026-077,BEN-${ref.slice(-4)},${amount},USD,EMAIL,ben-${ref.slice(-4).toLowerCase()}@example.org,${status},2026-11-05`;

describe('Phase 1 endpoints on SQLite', () => {
  it('serves health without authentication', async () => {
    const res = await fetch(`${app.baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', providerMode: 'simulation' });
  });

  it('returns the session without exposing secrets', async () => {
    const res = await fetch(`${app.baseUrl}/session`);
    const text = await res.text();
    expect(text).not.toContain('sk-test-should-never-leak');
    const body = JSON.parse(text) as SessionResponse;
    expect(body.user.role).toBe('operator');
    expect(body.organisation.isSynthetic).toBe(true);
    expect(body.environment.providerMode).toBe('simulation');
    expect(body.environment.ai.configured).toBe(true);
    expect(body.environment.paypal.configured).toBe(false);
    expect(body.environment.database.detail).toMatch(/SQLite/);
  });

  it('returns an overview computed from the database', async () => {
    const res = await fetch(`${app.baseUrl}/overview`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Overview;
    expect(body.asOf).toBe(TEST_NOW.toISOString());
    expect(body.payments.count).toBe(118);
    expect(body.recentEvents).toHaveLength(8);
  });

  it('returns structured errors with a request id', async () => {
    const res = await fetch(`${app.baseUrl}/does-not-exist`, { headers: { 'X-Request-Id': 'test-request-0001' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('x-request-id')).toBe('test-request-0001');
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error).toMatchObject({ code: 'not_found', requestId: 'test-request-0001' });
  });

  it('refuses sandbox mode without credentials, and never allows live PayPal', () => {
    expect(() => loadConfig({ PAYMENT_PROVIDER_MODE: 'sandbox' })).toThrow(/PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
    expect(() => loadConfig({ PAYMENT_PROVIDER_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_API_BASE_URL: 'https://api-m.paypal.com' })).toThrow(
      /Live PayPal is not supported/,
    );
  });
});

describe('cases API', () => {
  it('lists active seeded cases with filters, sorting and pagination', async () => {
    const res = await fetch(`${app.baseUrl}/cases?pageSize=5&sort=reference&order=asc`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CaseListResponse;
    expect(body.cases).toHaveLength(5);
    expect(body.total).toBeGreaterThan(5);
    expect(body.cases.every((c) => c.state !== 'resolved' && c.state !== 'closed')).toBe(true);
    const unclaimed = (await (await fetch(`${app.baseUrl}/cases?status=UNCLAIMED&state=all`)).json()) as CaseListResponse;
    expect(unclaimed.total).toBeGreaterThan(0);
    expect(unclaimed.cases.every((c) => c.status?.status === 'UNCLAIMED')).toBe(true);
  });

  it('rejects unknown filter values with a 422', async () => {
    const res = await fetch(`${app.baseUrl}/cases?status=PAID`);
    expect(res.status).toBe(422);
    expect(((await res.json()) as ApiErrorBody).error.code).toBe('validation_failed');
  });

  it('assigns with optimistic concurrency, records notes and refuses contact details in notes', async () => {
    const list = (await (await fetch(`${app.baseUrl}/cases?state=open&assignee=unassigned`)).json()) as CaseListResponse;
    const target = list.cases[0]!;
    const stale = await fetch(`${app.baseUrl}/cases/${target.id}/assign`, json({ expectedVersion: target.version + 5 }));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as ApiErrorBody).error.details).toMatchObject({ reason: 'stale_version', currentVersion: target.version });

    const assigned = await fetch(`${app.baseUrl}/cases/${target.id}/assign`, json({ expectedVersion: target.version }));
    expect(assigned.status).toBe(200);
    const detail = (await assigned.json()) as CaseDetail;
    expect(detail.case).toMatchObject({ state: 'investigating', version: target.version + 1, assignee: { id: 'usr_lena' } });
    expect(detail.timeline.some((e) => e.type === 'case_assigned')).toBe(true);
    expect(detail.history.some((h) => h.action === 'case.assigned' && h.outcome === 'succeeded')).toBe(true);
    expect(detail.history.some((h) => h.action === 'case.assigned' && h.outcome === 'rejected')).toBe(true);

    const replay = await fetch(`${app.baseUrl}/cases/${target.id}/assign`, json({ expectedVersion: target.version }));
    expect(replay.status).toBe(409);

    const leaky = await fetch(`${app.baseUrl}/cases/${target.id}/notes`, json({ body: 'Called them on +44 20 7946 0000' }));
    expect(leaky.status).toBe(422);
    const noted = await fetch(`${app.baseUrl}/cases/${target.id}/notes`, json({ body: 'Checked the programme register; reference matches.' }));
    expect(noted.status).toBe(201);
    const withNote = (await noted.json()) as CaseDetail;
    expect(withNote.notes.map((n) => n.body)).toEqual(['Checked the programme register; reference matches.']);
    const noteAudit = withNote.history.find((h) => h.action === 'case.note_added' && h.outcome === 'succeeded');
    expect(JSON.stringify(noteAudit)).not.toContain('programme register');
  });

  it('returns 404 for an unknown case', async () => {
    expect((await fetch(`${app.baseUrl}/cases/case_does_not_exist`)).status).toBe(404);
  });
});

describe('imports API', () => {
  it('imports the synthetic sample end to end and is idempotent', async () => {
    const sample = await fetch(`${app.baseUrl}/imports/sample.csv`);
    expect(sample.headers.get('content-type')).toMatch(/text\/csv/);
    const text = await sample.text();

    const validated = await uploadAndValidate('sample.csv', text);
    expect(validated.status).toBe('validated');
    expect(validated.summary!.outcomes).toMatchObject({ new_payment: 15, status_update: 2, rejected: 3 });

    const again = await upload(app.baseUrl, 'sample-copy.csv', text);
    expect(again.status).toBe(200);
    expect(((await again.json()) as UploadImportResponse).alreadyUploaded).toBe(true);

    const rejected = (await (await fetch(`${app.baseUrl}/imports/${validated.id}/rows?outcome=rejected`)).json()) as ImportRowsResponse;
    expect(rejected.rows.map((r) => r.issues.map((i) => i.code)).flat()).toEqual(
      expect.arrayContaining(['duplicate_reference_in_file', 'invalid_amount']),
    );
    expect(JSON.stringify(rejected.rows.map((r) => r.normalised))).not.toContain('ben-s19a16@example.org');

    const unconfirmed = await fetch(`${app.baseUrl}/imports/${validated.id}/commit`, json({ validationVersion: validated.validationVersion }));
    expect(unconfirmed.status).toBe(422);

    const commit = await fetch(`${app.baseUrl}/imports/${validated.id}/commit`, json({ validationVersion: validated.validationVersion, confirm: true }));
    expect(commit.status).toBe(200);
    const committed = (await commit.json()) as CommitImportResponse;
    expect(committed.alreadyCommitted).toBe(false);
    expect(committed.import.result).toMatchObject({ newPayments: 15, statusObservations: 17, rejected: 3 });
    expect(committed.import.result!.batchesCreated.map((b) => b.reference)).toEqual(['RR-B-2026-019']);
    expect(committed.import.result!.casesOpened.length).toBeGreaterThanOrEqual(7);

    const replay = await fetch(`${app.baseUrl}/imports/${validated.id}/commit`, json({ validationVersion: validated.validationVersion, confirm: true }));
    expect(((await replay.json()) as CommitImportResponse).alreadyCommitted).toBe(true);

    const overview = (await (await fetch(`${app.baseUrl}/overview`)).json()) as Overview;
    expect(overview.payments.count).toBe(118 + 15);

    const cases = (await (await fetch(`${app.baseUrl}/cases?import=${validated.id}&state=all&pageSize=100`)).json()) as CaseListResponse;
    const conflict = cases.cases.find((c) => c.openingReason === 'provider_status_conflict');
    expect(conflict).toBeDefined();
    const detail = (await (await fetch(`${app.baseUrl}/cases/${conflict!.id}`)).json()) as CaseDetail;
    expect(detail.provider?.status).toBe('SUCCESS');
    expect(detail.imported).toMatchObject({ status: 'FAILED', importId: validated.id, fileName: 'sample.csv' });
    expect(detail.observations).toHaveLength(1);
    expect(detail.observations[0]!.rowNumber).toBeGreaterThanOrEqual(2);
    expect(detail.nextAction.code).toBe('check_provider_status');
    expect(verifyAuditChain(temp.db).ok).toBe(true);
  });

  it('rejects files containing real contact details without storing anything', async () => {
    const before = ((await (await fetch(`${app.baseUrl}/imports`)).json()) as ImportListResponse).imports.length;
    const text = [HEADER, line('RR-T-REAL-0001').replace('ben-0001@example.org', 'jane.doe@gmail.com')].join('\n');
    const res = await upload(app.baseUrl, 'real.csv', text);
    expect(res.status).toBe(422);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.details).toMatchObject({ reason: 'real_contact_details' });
    expect(JSON.stringify(body)).not.toContain('jane.doe');
    const after = ((await (await fetch(`${app.baseUrl}/imports`)).json()) as ImportListResponse).imports.length;
    expect(after).toBe(before);
    const audit = temp.db.prepare("SELECT reason, new_state FROM audit_events WHERE action = 'import.rejected' ORDER BY seq DESC LIMIT 1").get() as {
      reason: string;
      new_state: string;
    };
    expect(audit.new_state).not.toContain('jane.doe');
  });

  it('refuses the wrong content type and oversized uploads', async () => {
    const wrongType = await fetch(`${app.baseUrl}/imports?fileName=a.csv`, json({ csv: 'a,b' }));
    expect(wrongType.status).toBe(415);
    const huge = await upload(app.baseUrl, 'huge.csv', 'a\n' + 'x'.repeat(2 * 1024 * 1024 + 10));
    expect(huge.status).toBe(413);
    expect(((await huge.json()) as ApiErrorBody).error.code).toBe('payload_too_large');
  });

  it('re-validates and refuses a commit when records changed after the preview', async () => {
    const first = await uploadAndValidate('first.csv', [HEADER, line('RR-T-STALE-0001'), line('RR-T-STALE-0002')].join('\n'));
    const second = await uploadAndValidate('second.csv', [HEADER, line('RR-T-STALE-0001'), line('RR-T-STALE-0003')].join('\n'));
    const ok = await fetch(`${app.baseUrl}/imports/${second.id}/commit`, json({ validationVersion: second.validationVersion, confirm: true }));
    expect(ok.status).toBe(200);

    const stale = await fetch(`${app.baseUrl}/imports/${first.id}/commit`, json({ validationVersion: first.validationVersion, confirm: true }));
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as ApiErrorBody;
    expect(body.error.details).toMatchObject({ reason: 'stale_preview', validationVersion: first.validationVersion + 1 });

    const refreshed = (await (await fetch(`${app.baseUrl}/imports/${first.id}`)).json()) as ImportDetail;
    expect(refreshed.summary!.outcomes).toMatchObject({ new_payment: 1, unchanged: 1 });
    const retry = await fetch(`${app.baseUrl}/imports/${first.id}/commit`, json({ validationVersion: refreshed.validationVersion, confirm: true }));
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as CommitImportResponse).import.result).toMatchObject({ newPayments: 1, unchanged: 1 });
  });

  it('discards drafts and refuses to change committed or discarded imports', async () => {
    const res = await upload(app.baseUrl, 'discard.csv', [HEADER, line('RR-T-DISC-0001')].join('\n'));
    const { import: created } = (await res.json()) as UploadImportResponse;
    const discarded = await fetch(`${app.baseUrl}/imports/${created.id}/discard`, { method: 'POST' });
    expect(((await discarded.json()) as ImportDetail).status).toBe('discarded');
    expect((await fetch(`${app.baseUrl}/imports/${created.id}/discard`, { method: 'POST' })).status).toBe(409);
    const remap = await fetch(`${app.baseUrl}/imports/${created.id}/mapping`, { ...json({ mapping: created.suggestedMapping }), method: 'PUT' });
    expect(remap.status).toBe(409);
  });
});

describe('role-based access', () => {
  it('lets a viewer read but not change anything, and audits each refusal', async () => {
    expect((await fetch(`${viewer.baseUrl}/overview`)).status).toBe(200);
    const list = (await (await fetch(`${viewer.baseUrl}/cases?state=open`)).json()) as CaseListResponse;
    const target = list.cases[0]!;
    const detail = (await (await fetch(`${viewer.baseUrl}/cases/${target.id}`)).json()) as CaseDetail;
    expect(detail.permissions).toEqual({ canAssign: false, canAddNote: false });

    const before = (temp.db.prepare("SELECT count(*) AS n FROM audit_events WHERE outcome = 'rejected' AND actor_user_id = 'usr_tomas'").get() as { n: number }).n;
    expect((await upload(viewer.baseUrl, 'viewer.csv', [HEADER, line('RR-T-VIEW-0001')].join('\n'))).status).toBe(403);
    expect((await fetch(`${viewer.baseUrl}/cases/${target.id}/assign`, json({ expectedVersion: target.version }))).status).toBe(403);
    expect((await fetch(`${viewer.baseUrl}/cases/${target.id}/notes`, json({ body: 'Viewer note' }))).status).toBe(403);
    const after = (temp.db.prepare("SELECT count(*) AS n FROM audit_events WHERE outcome = 'rejected' AND actor_user_id = 'usr_tomas'").get() as { n: number }).n;
    expect(after - before).toBe(3);
  });
});
