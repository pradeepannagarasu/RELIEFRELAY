import { afterEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, PaymentActionsResponse, ProposalDetail, ProposalResponse } from '@shared/api/contracts';
import { verifyAuditChain } from '../audit/auditLog';
import { createSeededDatabase, startApp } from '../test-support/seededApp';
import { ADMIN, APPROVER, OPERATOR, ORG, post, SANDBOX_RECEIVER, startSandboxHarness, VIEWER, type SandboxHarness } from '../test-support/sandboxHarness';
import { deactivateEntry } from './allowlist';
import { DAY, HOUR, MINUTE } from './records';

let h: SandboxHarness;
afterEach(async () => {
  await h?.close();
});

const JUSTIFICATION = 'Provider confirmed the payment was returned; programme team asked for one reissue.';

async function actions(caseId: string, user = OPERATOR): Promise<PaymentActionsResponse> {
  const res = await fetch(`${h.base(user)}/cases/${caseId}/payment-actions`);
  expect(res.status).toBe(200);
  return (await res.json()) as PaymentActionsResponse;
}

async function propose(caseId: string, action: 'reissue' | 'cancel_unclaimed' = 'reissue', user = OPERATOR) {
  const current = await actions(caseId, user);
  return post(`${h.base(user)}/cases/${caseId}/proposals`, {
    action,
    reasonCode: action === 'reissue' ? 'returned_unclaimed' : 'recipient_cannot_claim',
    justification: JUSTIFICATION,
    attestation: true,
    caseVersion: current.case.version,
    providerFingerprint: current.providerFingerprint,
  });
}

async function proposeOk(caseId: string, action: 'reissue' | 'cancel_unclaimed' = 'reissue'): Promise<ProposalDetail> {
  const res = await propose(caseId, action);
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as ProposalResponse).proposal;
}

async function getProposal(id: string, user = APPROVER): Promise<ProposalDetail> {
  return ((await (await fetch(`${h.base(user)}/proposals/${id}`)).json()) as ProposalResponse).proposal;
}

async function approve(id: string, user = APPROVER, confirmation?: string) {
  const detail = await getProposal(id, user);
  return post(`${h.base(user)}/proposals/${id}/approve`, { proposalVersion: detail.version, confirmation: confirmation ?? detail.confirmationPhrase });
}

async function approveOk(id: string): Promise<ProposalDetail> {
  const res = await approve(id);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as ProposalResponse).proposal;
}

const caseState = (caseId: string) => (h.temp.db.prepare('SELECT state FROM payment_cases WHERE id = ?').get(caseId) as { state: string }).state;

async function reissueAccepted() {
  const scenario = h.scenario();
  const proposal = await proposeOk(scenario.caseId);
  const approved = await approveOk(proposal.id);
  return { scenario, proposal: approved };
}

describe('payment actions in simulation mode', () => {
  it('are disabled and refused on the server', async () => {
    const temp = createSeededDatabase();
    const app = await startApp(temp);
    try {
      const caseRow = temp.db
        .prepare("SELECT c.id FROM payment_cases c JOIN provider_transactions p ON p.payment_item_id = c.payment_item_id WHERE p.status = 'RETURNED' AND c.state IN ('open','investigating') LIMIT 1")
        .get() as { id: string };
      const res = await fetch(`${app.baseUrl}/cases/${caseRow.id}/payment-actions`);
      const body = (await res.json()) as PaymentActionsResponse;
      expect(body.enabled).toBe(false);
      expect(body.blocks.map((b) => b.code)).toContain('simulation_mode');
      expect(body.reissue.available).toBe(false);
      const refused = await post(`${app.baseUrl}/cases/${caseRow.id}/proposals`, {
        action: 'reissue',
        reasonCode: 'returned_unclaimed',
        justification: JUSTIFICATION,
        attestation: true,
        caseVersion: body.case.version,
        providerFingerprint: body.providerFingerprint,
      });
      expect(refused.status).toBe(409);
      expect(temp.db.prepare('SELECT count(*) AS n FROM payout_proposals').get()).toEqual({ n: 0 });
    } finally {
      await app.close();
      temp.cleanup();
    }
  });
});

describe('reissue through PayPal Sandbox (local stub)', () => {
  it('runs propose, four-eyes approval with typed confirmation, submission and status sync', async () => {
    h = await startSandboxHarness();
    const scenario = h.scenario();
    const before = await actions(scenario.caseId);
    expect(before.enabled).toBe(true);
    expect(before.reissue).toMatchObject({ available: true, attemptNumber: 1, receiverAllowlisted: true, senderItemId: `${scenario.paymentReference}-R1` });
    expect(before.original.provider).toMatchObject({ mode: 'simulation', status: 'RETURNED' });

    const proposal = await proposeOk(scenario.caseId);
    expect(proposal.status).toBe('pending_approval');
    expect(caseState(scenario.caseId)).toBe('awaiting_approval');
    expect(proposal.confirmationPhrase).toBe(`${scenario.paymentReference} 12.50 GBP`);

    // The proposer cannot approve, even as an administrator would; the refusal is audited.
    const self = await approve(proposal.id, OPERATOR);
    expect(self.status).toBe(403);
    const viewer = await approve(proposal.id, VIEWER);
    expect(viewer.status).toBe(403);
    const wrong = await approve(proposal.id, APPROVER, `${scenario.paymentReference} 125.00 GBP`);
    expect(wrong.status).toBe(422);
    expect(h.stub.count('create')).toBe(0);

    const approved = await approveOk(proposal.id);
    expect(approved.status).toBe('approved');
    expect(approved.submission).toMatchObject({ state: 'accepted', attemptCount: 1, senderItemId: `${scenario.paymentReference}-R1` });

    // Exactly one create request, with the approved keys and an exact two-decimal amount.
    const creates = h.stub.requests.filter((r) => r.route === 'create');
    expect(creates).toHaveLength(1);
    const sent = JSON.parse(creates[0]!.body) as { sender_batch_header: { sender_batch_id: string }; items: { amount: { value: string; currency: string }; receiver: string; recipient_type: string }[] };
    expect(sent.items).toHaveLength(1);
    expect(sent.items[0]).toMatchObject({ recipient_type: 'EMAIL', receiver: SANDBOX_RECEIVER, amount: { value: '12.50', currency: 'GBP' } });
    expect(creates[0]!.headers['paypal-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.sender_batch_header.sender_batch_id).toBe(approved.submission!.senderBatchId);

    // Batch status and item status are stored separately.
    const after = await actions(scenario.caseId);
    expect(caseState(scenario.caseId)).toBe('recovery_submitted');
    expect(after.recoveries).toHaveLength(1);
    expect(after.recoveries[0]!.batch).toMatchObject({ providerMode: null, status: 'SUCCESS' });
    expect(after.recoveries[0]!.provider).toMatchObject({ mode: 'sandbox', status: 'UNCLAIMED' });
    expect(after.original.provider).toMatchObject({ mode: 'simulation', status: 'RETURNED' });

    // Local-stub answers are labelled as stub responses wherever they are stored or returned, never as PayPal Sandbox.
    expect(after.sandboxNotice).toMatch(/^Local PayPal stub: /);
    expect(JSON.stringify(after)).not.toContain('PayPal Sandbox');
    expect(JSON.stringify(approved)).not.toContain('PayPal Sandbox');
    const events = h.temp.db.prepare('SELECT source, summary FROM payment_events WHERE case_id = ?').all(scenario.caseId) as { source: string; summary: string }[];
    expect(events.map((e) => e.source)).not.toContain('sandbox');
    expect(events.find((e) => e.summary.startsWith('Recovery payout'))!.summary).toMatch(/accepted by the local PayPal stub .* Local stub test response: nothing was sent to PayPal/);

    // A later status check that shows SUCCESS resolves the case, credited to the approver.
    h.stub.setItemStatus(after.recoveries[0]!.provider!.providerItemId!, 'SUCCESS');
    h.advance(MINUTE);
    const check = await post(`${h.base(OPERATOR)}/cases/${scenario.caseId}/payment-actions/status-checks`, { itemId: after.recoveries[0]!.itemId });
    expect(check.status).toBe(201);
    const resolved = h.temp.db.prepare('SELECT state, resolution_kind, resolved_by_user_id, recovery_item_id FROM payment_cases WHERE id = ?').get(scenario.caseId);
    expect(resolved).toEqual({ state: 'resolved', resolution_kind: 'recovered', resolved_by_user_id: APPROVER, recovery_item_id: after.recoveries[0]!.itemId });
    const stored = h.temp.db
      .prepare(
        `SELECT summary AS text FROM payment_events WHERE case_id = ?
         UNION ALL SELECT resolution_summary FROM payment_cases WHERE id = ?
         UNION ALL SELECT reason FROM audit_events WHERE action LIKE 'payout.%' AND reason IS NOT NULL`,
      )
      .all(scenario.caseId, scenario.caseId) as { text: string }[];
    expect(stored.length).toBeGreaterThan(5);
    expect(stored.filter((r) => r.text.includes('PayPal Sandbox'))).toEqual([]);
    expect(h.temp.db.prepare('SELECT target FROM paypal_target_binding').all()).toEqual([{ target: 'local_stub' }]);

    const audit = h.temp.db.prepare("SELECT action, outcome FROM audit_events WHERE action LIKE 'payout.%' ORDER BY seq").all() as { action: string; outcome: string }[];
    expect(audit).toContainEqual({ action: 'payout.proposal_approved', outcome: 'rejected' });
    expect(audit).toContainEqual({ action: 'payout.proposal_approved', outcome: 'succeeded' });
    expect(audit).toContainEqual({ action: 'payout.submission_accepted', outcome: 'succeeded' });
    expect(verifyAuditChain(h.temp.db).ok).toBe(true);
  });

  it('replays a lost response with the same keys and PayPal returns the original batch', async () => {
    h = await startSandboxHarness();
    h.stub.faults.create.push({ kind: 'process_then_drop' });
    const { proposal } = await reissueAccepted();
    expect(proposal.submission).toMatchObject({ state: 'accepted', attemptCount: 2 });
    const creates = h.stub.requests.filter((r) => r.route === 'create');
    expect(creates).toHaveLength(2);
    expect(creates[0]!.headers['paypal-request-id']).toBe(creates[1]!.headers['paypal-request-id']);
    expect(creates[0]!.body).toBe(creates[1]!.body);
    expect(h.stub.batches.size).toBe(1);
  });

  it('keeps an unknown outcome blocked, replays on schedule and never changes the keys', async () => {
    h = await startSandboxHarness();
    for (let i = 0; i < 3; i += 1) h.stub.faults.create.push({ kind: 'status', status: 503 });
    const scenario = h.scenario();
    const proposal = await proposeOk(scenario.caseId);
    const approved = await approveOk(proposal.id);
    expect(approved.submission).toMatchObject({ state: 'outcome_unknown', attemptCount: 3 });
    const blocked = await actions(scenario.caseId);
    expect(blocked.blocks.map((b) => b.code)).toContain('submission_in_progress');
    expect((await propose(scenario.caseId)).status).toBe(409);

    h.advance(10 * MINUTE);
    await h.payouts.submissions.processDue();
    const after = await getProposal(proposal.id);
    expect(after.submission).toMatchObject({ state: 'accepted', attemptCount: 4 });
    const ids = new Set(h.stub.requests.filter((r) => r.route === 'create').map((r) => r.headers['paypal-request-id']));
    expect(ids.size).toBe(1);
    expect(h.stub.batches.size).toBe(1);
  });

  it('stops replaying at the 25-day deadline and requires manual reconciliation', async () => {
    h = await startSandboxHarness();
    for (let i = 0; i < 40; i += 1) h.stub.faults.create.push({ kind: 'status', status: 500 });
    const scenario = h.scenario();
    const proposal = await proposeOk(scenario.caseId);
    const approved = await approveOk(proposal.id);
    const subId = approved.submission!.id;
    for (let day = 0; day < 26; day += 1) {
      h.advance(DAY);
      await h.payouts.submissions.processDue();
    }
    const sub = h.temp.db.prepare('SELECT state, attempt_count, last_attempt_at, replay_deadline_at FROM payout_submissions WHERE id = ?').get(subId) as {
      state: string;
      attempt_count: number;
      last_attempt_at: string;
      replay_deadline_at: string;
    };
    expect(sub.state).toBe('needs_manual_reconciliation');
    expect(sub.last_attempt_at < sub.replay_deadline_at).toBe(true);
    expect(sub.attempt_count).toBeLessThanOrEqual(30);
    const blocked = await actions(scenario.caseId, ADMIN);
    expect(blocked.blocks.map((b) => b.code)).toContain('manual_reconciliation_required');

    // Recording "not created" is refused until PayPal's 30-day duplicate protection has passed.
    const early = await post(`${h.base(ADMIN)}/submissions/${subId}/reconcile`, { action: 'record_not_created', note: 'Checked the Sandbox dashboard: no batch exists.' });
    expect(early.status).toBe(409);
    const notAdmin = await post(`${h.base(APPROVER)}/submissions/${subId}/reconcile`, { action: 'record_not_created', note: 'Checked the Sandbox dashboard: no batch exists.' });
    expect(notAdmin.status).toBe(403);
    h.setNow(new Date(Date.parse(approved.submission!.approvedAt) + 31 * DAY + HOUR));
    const late = await post(`${h.base(ADMIN)}/submissions/${subId}/reconcile`, { action: 'record_not_created', note: 'Checked the Sandbox dashboard: no batch exists.' });
    expect(late.status, await late.clone().text()).toBe(200);
    expect(caseState(scenario.caseId)).toBe('investigating');
    expect(h.temp.db.prepare('SELECT state FROM payout_submissions WHERE id = ?').get(subId)).toEqual({ state: 'reconciled_not_created' });
  });

  it('records a definite refusal as rejected and returns the case to investigation', async () => {
    h = await startSandboxHarness();
    h.stub.faults.create.push({ kind: 'status', status: 422, body: { name: 'VALIDATION_ERROR', message: 'Invalid request', debug_id: 'dbg1' } });
    const { scenario, proposal } = await reissueAccepted();
    expect(proposal.submission).toMatchObject({ state: 'rejected', lastErrorName: 'VALIDATION_ERROR', recoveryItem: null });
    expect(caseState(scenario.caseId)).toBe('investigating');
    expect(h.stub.count('create')).toBe(1);
  });

  it('never treats a refused replay as "not created": an earlier attempt may have created the payout', async () => {
    h = await startSandboxHarness();
    h.stub.faults.create.push({ kind: 'process_then_drop' });
    h.stub.faults.create.push({ kind: 'status', status: 422, body: { name: 'VALIDATION_ERROR', message: 'Invalid request', debug_id: 'dbg2' } });
    const scenario = h.scenario();
    const proposal = await proposeOk(scenario.caseId);
    const approved = await approveOk(proposal.id);
    expect(approved.submission).toMatchObject({ state: 'needs_manual_reconciliation', attemptCount: 2, lastErrorName: 'VALIDATION_ERROR', recoveryItem: null });
    expect(h.stub.batches.size).toBe(1);
    expect(caseState(scenario.caseId)).toBe('recovery_submitted');
    expect((await actions(scenario.caseId, ADMIN)).blocks.map((b) => b.code)).toContain('manual_reconciliation_required');
    h.advance(DAY);
    await h.payouts.submissions.processDue();
    expect(h.stub.count('create')).toBe(2);
  });

  it('refuses approval, without sending, when the receiver left the allowlist', async () => {
    h = await startSandboxHarness();
    const scenario = h.scenario();
    const proposal = await proposeOk(scenario.caseId);
    deactivateEntry(h.temp.db, ORG, SANDBOX_RECEIVER, 'Test account retired', h.now());
    const res = await approve(proposal.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErrorBody).error.message).toMatch(/allowlist/);
    expect(h.stub.count('create')).toBe(0);
  });

  it('never offers a reissue to a receiver that is not allowlisted', async () => {
    h = await startSandboxHarness();
    const seeded = h.temp.db
      .prepare("SELECT c.id FROM payment_cases c JOIN provider_transactions p ON p.payment_item_id = c.payment_item_id WHERE p.status = 'RETURNED' AND c.state IN ('open','investigating') LIMIT 1")
      .get() as { id: string };
    const body = await actions(seeded.id);
    expect(body.reissue.available).toBe(false);
    expect(body.reissue.receiverAllowlisted).toBe(false);
    expect(body.reissue.reasons.join(' ')).toMatch(/allowlist/);
    expect((await propose(seeded.id)).status).toBe(409);
  });

  it('enforces the daily value limit per currency on the server', async () => {
    h = await startSandboxHarness();
    for (let i = 0; i < 4; i += 1) {
      const scenario = h.scenario(50_000);
      await approveOk((await proposeOk(scenario.caseId)).id);
    }
    const fifth = h.scenario(50_000);
    const proposal = await proposeOk(fifth.caseId);
    const detail = await getProposal(proposal.id);
    expect(detail.checks.find((c) => c.code === 'limits')?.passed).toBe(false);
    const res = await approve(proposal.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiErrorBody).error.details).toMatchObject({ reason: 'daily_value_limit' });
    expect(h.stub.count('create')).toBe(4);
  });

  it('expires undecided proposals after 72 hours and restores the case', async () => {
    h = await startSandboxHarness();
    const scenario = h.scenario();
    const proposal = await proposeOk(scenario.caseId);
    h.advance(72 * HOUR);
    const detail = await getProposal(proposal.id);
    expect(detail.status).toBe('expired');
    expect(caseState(scenario.caseId)).toBe('open');
    expect((await approve(proposal.id)).status).toBe(409);
  });

  it('lets the proposer withdraw and an approver reject, restoring the case each time', async () => {
    h = await startSandboxHarness();
    const scenario = h.scenario();
    const first = await proposeOk(scenario.caseId);
    const withdraw = await post(`${h.base(OPERATOR)}/proposals/${first.id}/withdraw`, { proposalVersion: first.version, reason: 'Proposed on the wrong case.' });
    expect(withdraw.status).toBe(200);
    expect(caseState(scenario.caseId)).toBe('open');
    const second = await proposeOk(scenario.caseId);
    const selfReject = await post(`${h.base(OPERATOR)}/proposals/${second.id}/reject`, { proposalVersion: second.version, reason: 'Not needed.' });
    expect(selfReject.status).toBe(403);
    const reject = await post(`${h.base(APPROVER)}/proposals/${second.id}/reject`, { proposalVersion: second.version, reason: 'Need programme confirmation first.' });
    expect(reject.status).toBe(200);
    expect(caseState(scenario.caseId)).toBe('open');
    expect(h.stub.count('create')).toBe(0);
  });

  it('is switched off by PAYPAL_PAYOUTS_ENABLED', async () => {
    h = await startSandboxHarness({ env: { PAYPAL_PAYOUTS_ENABLED: 'false' } });
    const scenario = h.scenario();
    const body = await actions(scenario.caseId);
    expect(body.enabled).toBe(false);
    expect(body.blocks.map((b) => b.code)).toContain('payouts_disabled');
    expect((await propose(scenario.caseId)).status).toBe(409);
  });
});

describe('cancelling an unclaimed Sandbox payout (local stub)', () => {
  it('checks the status, sends once, confirms RETURNED and returns the case to investigation', async () => {
    h = await startSandboxHarness();
    const { scenario } = await reissueAccepted();
    const proposal = await proposeOk(scenario.caseId, 'cancel_unclaimed');
    expect(proposal.confirmationPhrase).toBe(`CANCEL ${scenario.paymentReference}-R1`);
    const approved = await approveOk(proposal.id);
    expect(approved.cancellation).toMatchObject({ state: 'succeeded', sendCount: 1, resolvedBy: 'cancel_response' });
    expect(h.stub.count('cancel')).toBe(1);
    expect(caseState(scenario.caseId)).toBe('investigating');
    const after = await actions(scenario.caseId);
    expect(after.recoveries[0]!.provider?.status).toBe('RETURNED');
    const sources = (h.temp.db.prepare('SELECT source FROM provider_status_checks ORDER BY checked_at, rowid').all() as { source: string }[]).map((r) => r.source);
    expect(sources).toEqual(expect.arrayContaining(['precheck', 'confirm']));

    // A reissue now needs a fresh status check and a separate approval.
    expect(after.reissue).toMatchObject({ available: true, attemptNumber: 2 });
    h.advance(20 * MINUTE);
    expect((await actions(scenario.caseId)).reissue.statusCheckRequired).toBe(true);
    const second = await proposeOk(scenario.caseId);
    expect(second.attemptNumber).toBe(2);
    expect(h.temp.db.prepare("SELECT count(*) AS n FROM provider_status_checks WHERE source = 'precheck'").get()).toEqual({ n: 2 });
  });

  it('resolves a lost cancel response by fetching the status, never by resending', async () => {
    h = await startSandboxHarness();
    const { scenario } = await reissueAccepted();
    h.stub.faults.cancel.push({ kind: 'process_then_drop' });
    const proposal = await proposeOk(scenario.caseId, 'cancel_unclaimed');
    const approved = await approveOk(proposal.id);
    expect(approved.cancellation).toMatchObject({ state: 'succeeded', sendCount: 1, resolvedBy: 'status_check' });
    expect(h.stub.count('cancel')).toBe(1);
  });

  it('does not cancel a payout that was claimed after approval', async () => {
    h = await startSandboxHarness();
    const { scenario } = await reissueAccepted();
    const proposal = await proposeOk(scenario.caseId, 'cancel_unclaimed');
    const recovery = (await actions(scenario.caseId)).recoveries[0]!;
    h.stub.setItemStatus(recovery.provider!.providerItemId!, 'SUCCESS');
    const approved = await approveOk(proposal.id);
    expect(approved.cancellation).toMatchObject({ state: 'not_applicable', sendCount: 0 });
    expect(h.stub.count('cancel')).toBe(0);
    expect(caseState(scenario.caseId)).toBe('resolved');
  });

  it('supersedes a pending proposal when the provider status changes', async () => {
    h = await startSandboxHarness();
    const { scenario } = await reissueAccepted();
    const proposal = await proposeOk(scenario.caseId, 'cancel_unclaimed');
    const recovery = (await actions(scenario.caseId)).recoveries[0]!;
    h.stub.setItemStatus(recovery.provider!.providerItemId!, 'SUCCESS');
    h.advance(MINUTE);
    await post(`${h.base(OPERATOR)}/cases/${scenario.caseId}/payment-actions/status-checks`, { itemId: recovery.itemId });
    expect((await getProposal(proposal.id)).status).toBe('superseded');
    expect(caseState(scenario.caseId)).toBe('resolved');
    expect(h.stub.count('cancel')).toBe(0);
  });
});

describe('provider discrepancies', () => {
  it('records a critical discrepancy and blocks further actions until an administrator resolves it', async () => {
    h = await startSandboxHarness();
    const { scenario } = await reissueAccepted();
    const recovery = (await actions(scenario.caseId)).recoveries[0]!;
    h.stub.setItemStatus(recovery.provider!.providerItemId!, 'RETURNED');
    h.stub.itemOverrides = { amount: { value: '125.00', currency: 'GBP' } };
    h.advance(MINUTE);
    await post(`${h.base(OPERATOR)}/cases/${scenario.caseId}/payment-actions/status-checks`, { itemId: recovery.itemId });
    const body = await actions(scenario.caseId, ADMIN);
    expect(body.discrepancies).toHaveLength(1);
    expect(body.discrepancies[0]).toMatchObject({ code: 'amount_mismatch', severity: 'critical', expected: '1250', actual: '12500' });
    expect(body.blocks.map((b) => b.code)).toContain('discrepancy_unresolved');
    const resolve = await post(`${h.base(ADMIN)}/discrepancies/${body.discrepancies[0]!.id}/resolve`, { note: 'Reviewed in the Sandbox dashboard; stub override in test.' });
    expect(resolve.status).toBe(200);
    expect((await actions(scenario.caseId)).blocks.map((b) => b.code)).not.toContain('discrepancy_unresolved');
  });
});

describe('database safeguards', () => {
  it('refuses self-approval and phone receivers even with direct SQL', async () => {
    h = await startSandboxHarness();
    const scenario = h.scenario();
    const proposal = await proposeOk(scenario.caseId);
    expect(() =>
      h.temp.db
        .prepare("UPDATE payout_proposals SET status = 'approved', decided_by_user_id = proposed_by_user_id, decided_at = ?, confirmation_sha256 = ?, version = version + 1 WHERE id = ?")
        .run(h.now().toISOString(), 'a'.repeat(64), proposal.id),
    ).toThrow();
    expect(() =>
      h.temp.db
        .prepare("INSERT INTO sandbox_receiver_allowlist (id, organisation_id, receiver_type, receiver_value, receiver_masked, label, added_via, added_at) VALUES ('rcv_x', ?, 'PHONE', '+447700900123', 'x', 'phone', 'cli', ?)")
        .run(ORG, h.now().toISOString()),
    ).toThrow();
    expect(() =>
      h.temp.db
        .prepare("INSERT INTO sandbox_receiver_allowlist (id, organisation_id, receiver_type, receiver_value, receiver_masked, label, added_via, added_at) VALUES ('rcv_y', ?, 'EMAIL', 'someone@gmail.com', 'x', 'real', 'cli', ?)")
        .run(ORG, h.now().toISOString()),
    ).toThrow();
    expect(() => h.temp.db.prepare("INSERT INTO payout_submissions (id, organisation_id, case_id, proposal_id, sender_batch_id, paypal_request_id, request_sha256, approved_at, replay_deadline_at) VALUES ('sub_x', ?, ?, ?, 'RRS-ABCDEFGH', ?, ?, ?, ?)").run(
      ORG, scenario.caseId, proposal.id, '0'.repeat(36), 'a'.repeat(64), h.now().toISOString(), new Date(h.now().getTime() + 25 * DAY).toISOString(),
    )).toThrow(/approved by someone other/);
  });

  it('keeps submission keys, approvals and provider evidence immutable', async () => {
    h = await startSandboxHarness();
    const { proposal } = await reissueAccepted();
    const sub = h.temp.db.prepare('SELECT id FROM payout_submissions WHERE proposal_id = ?').get(proposal.id) as { id: string };
    const db = h.temp.db;
    expect(() => db.prepare("UPDATE payout_submissions SET paypal_request_id = '11111111-1111-4111-8111-111111111111' WHERE id = ?").run(sub.id)).toThrow();
    expect(() => db.prepare("UPDATE payout_submissions SET sender_batch_id = 'RRS-OTHER' WHERE id = ?").run(sub.id)).toThrow();
    expect(() => db.prepare("UPDATE payout_submissions SET state = 'outcome_unknown' WHERE id = ?").run(sub.id)).toThrow(/finished submission/);
    expect(() => db.prepare('DELETE FROM payout_submissions WHERE id = ?').run(sub.id)).toThrow();
    expect(() => db.prepare("UPDATE payout_proposals SET justification = 'changed after approval' WHERE id = ?").run(proposal.id)).toThrow();
    expect(() => db.prepare('DELETE FROM payout_proposals WHERE id = ?').run(proposal.id)).toThrow();
    expect(() => db.prepare("UPDATE provider_status_checks SET item_status = 'SUCCESS'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM provider_status_checks').run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM sandbox_receiver_allowlist').run()).toThrow(/deactivate/);
    expect(() =>
      db
        .prepare("INSERT INTO payout_reconciliations (id, organisation_id, submission_id, action, provider_batch_id, user_id, recorded_at) VALUES ('rec_x', ?, ?, 'link_batch', 'BATCHX', ?, ?)")
        .run(ORG, sub.id, APPROVER, h.now().toISOString()),
    ).toThrow(/only an administrator/);
    expect(() =>
      db
        .prepare("INSERT INTO payout_reconciliations (id, organisation_id, submission_id, action, note, user_id, recorded_at) VALUES ('rec_y', ?, ?, 'record_not_created', 'Never created at PayPal.', ?, ?)")
        .run(ORG, sub.id, ADMIN, h.now().toISOString()),
    ).toThrow(/31 days/);
  });
});
