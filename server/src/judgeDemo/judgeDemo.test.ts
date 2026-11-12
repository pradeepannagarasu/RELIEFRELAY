import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DemoIdentitiesResponse, OverviewResponse, PaymentActionsResponse, ProposalResponse, SessionResponse } from '@shared/api/contracts';
import { createApp } from '../app';
import { verifyAuditChain } from '../audit/auditLog';
import { loadConfig } from '../config/env';
import { JUDGE_GATEWAY_HEADER } from '../middleware/publicDemo';
import { assertJudgeApi, createPublicGateway } from '../publicDemo/gateway';
import { createRateLimiter } from '../publicDemo/rateLimit';
import { DEMO_SESSION_USER_ID } from '../seed/syntheticDataset';
import { startPayPalStub } from '../test-support/paypalStub';
import { APPROVER, OPERATOR, ORG, post, startSandboxHarness } from '../test-support/sandboxHarness';
import { createSeededDatabase, startApp, TEST_NOW, type RunningApp } from '../test-support/seededApp';
import type { TempDatabase } from '../test-support/tempDb';
import { createPayPalClient } from '../paypal/client';
import { assertNoAdminRole, createIdentitySigner, JUDGE_ROLES } from './identity';
import { decideJudgeStart, lastJudgeActivity, loadOrCreateIdentitySecret, portInUse, removeJudgeDemoFiles, restoreStubPayouts } from './persistence';
import { createJudgeScenario, JUDGE_OUTCOMES, JUDGE_RECEIVERS, JUDGE_SETTLE_MS, judgeOutcomeFor, registerJudgeReceivers, type JudgeOutcome } from './scenarios';
import { assertJudgeIsolation, judgeDemoEnv } from './server';

const WRITE = { 'X-ReliefRelay-Demo': '1' };

describe('signed Judge Demo identities', () => {
  it('verifies only values signed with the same secret', () => {
    const signer = createIdentitySigner();
    const value = signer.sign('usr_samuel');
    expect(signer.verify(value)).toBe('usr_samuel');
    expect(signer.verify('usr_samuel')).toBeNull();
    expect(signer.verify(value.replace('usr_samuel', 'usr_priya'))).toBeNull();
    expect(signer.verify(`${value}x`)).toBeNull();
    expect(signer.verify(createIdentitySigner().sign('usr_samuel'))).toBeNull();
    expect(signer.verify('')).toBeNull();
    expect(() => createIdentitySigner(randomBytes(8))).toThrow();
  });

  it('never allows the administrator role', () => {
    expect(JUDGE_ROLES).not.toContain('admin');
    expect(() => assertNoAdminRole(['operator', 'admin'])).toThrow();
  });
});

describe('Judge Demo API', () => {
  let temp: TempDatabase;
  let server: Server;
  let base: string;
  const signer = createIdentitySigner();

  beforeAll(async () => {
    temp = createSeededDatabase();
    registerJudgeReceivers(temp.db, ORG, TEST_NOW);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: temp.path });
    const app = createApp({ config, logger: pino({ level: 'silent' }), db: temp.db, demoUserId: DEMO_SESSION_USER_ID, clock: () => TEST_NOW, aiProvider: null, judgeDemo: { signer, roles: JUDGE_ROLES } });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    temp.cleanup();
  });

  const session = async (cookie?: string, headers: Record<string, string> = {}) =>
    (await (await fetch(`${base}/session`, { headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) } })).json()) as SessionResponse;

  it('reports the Judge Demo and acts as the operator by default', async () => {
    const body = await session();
    expect(body.environment.judgeDemo).toBe(true);
    expect(body.environment.demoRoleSwitcher).toBe(true);
    expect(body.environment.publicReadOnly).toBe(false);
    expect(body.user).toMatchObject({ id: OPERATOR, role: 'operator' });
  });

  it('ignores unsigned, forged and administrator cookies and identity headers', async () => {
    expect((await session('rr_demo_user=usr_priya')).user.role).toBe('operator');
    expect((await session('rr_demo_user=usr_samuel')).user.role).toBe('operator');
    expect((await session(`rr_demo_user=${createIdentitySigner().sign('usr_samuel')}`)).user.role).toBe('operator');
    // Even a correctly signed administrator id is refused, because the role is not permitted.
    expect((await session(`rr_demo_user=${signer.sign('usr_priya')}`)).user.role).toBe('operator');
    expect((await session(undefined, { 'X-ReliefRelay-Role': 'admin', 'X-ReliefRelay-User': 'usr_priya' })).user.role).toBe('operator');
    expect((await session(`rr_demo_user=${signer.sign('usr_samuel')}`)).user.role).toBe('approver');
  });

  it('lists only permitted identities, refuses the administrator and issues signed cookies', async () => {
    const list = (await (await fetch(`${base}/demo/identities`)).json()) as DemoIdentitiesResponse;
    expect(list.identities.map((i) => i.role).sort()).toEqual(['approver', 'operator', 'viewer']);
    const admin = await post(`${base}/demo/identity`, { userId: 'usr_priya' }, WRITE);
    expect(admin.status).toBe(403);
    const ok = await post(`${base}/demo/identity`, { userId: APPROVER }, WRITE);
    expect(ok.status).toBe(200);
    const cookie = ok.headers.getSetCookie().find((c) => c.startsWith('rr_demo_user='))!;
    const value = decodeURIComponent(cookie.split(';')[0]!.slice('rr_demo_user='.length));
    expect(signer.verify(value)).toBe(APPROVER);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('creates labelled scenario cases for operators and approvers but not viewers', async () => {
    const created = await post(`${base}/judge-demo/scenarios`, { outcome: 'FAILED' }, WRITE);
    expect(created.status).toBe(201);
    const body = (await created.json()) as { caseId: string; caseReference: string; outcome: string };
    expect(body.outcome).toBe('FAILED');
    const viewer = await post(`${base}/judge-demo/scenarios`, { outcome: 'FAILED' }, { ...WRITE, Cookie: `rr_demo_user=${signer.sign('usr_tomas')}` });
    expect(viewer.status).toBe(403);
    expect((await post(`${base}/judge-demo/scenarios`, { outcome: 'LIVE' }, WRITE)).status).toBe(422);
    expect((await post(`${base}/judge-demo/scenarios`, { outcome: 'SUCCESS' })).status).toBe(403);
  });

  it('keeps the administrator connection check out of reach', async () => {
    const res = await post(`${base}/integrations/paypal/connection-check`, {}, WRITE);
    expect(res.status).toBe(403);
  });
});

describe('separation from the private API', () => {
  let temp: TempDatabase;
  let api: RunningApp;
  beforeAll(async () => {
    temp = createSeededDatabase();
    api = await startApp(temp);
  });
  afterAll(async () => {
    await api.close();
    temp.cleanup();
  });

  it('refuses every Judge Demo gateway request on an API that is not the Judge Demo', async () => {
    for (const path of ['/session', '/overview', '/cases']) {
      expect((await fetch(`${api.baseUrl}${path}`, { headers: { [JUDGE_GATEWAY_HEADER]: '1' } })).status, path).toBe(403);
    }
    await expect(assertJudgeApi(new URL(api.baseUrl).origin)).rejects.toThrow(/not the Judge Demo/);
    expect((await fetch(`${api.baseUrl}/session`)).status).toBe(200);
  });

  it('separates historical awaiting-approval cases from current proposals and sent payouts', async () => {
    const body = (await (await fetch(`${api.baseUrl}/overview`)).json()) as OverviewResponse;
    expect(body.cases.byState.awaiting_approval).toBe(2);
    expect(body.approvalSources).toMatchObject({ historicalAwaitingCases: 2, pendingProposals: 0, submittedPayouts: 0 });
  });

  it('replaces every PayPal setting and refuses anything but the local stub and a separate database', () => {
    const env = judgeDemoEnv('http://127.0.0.1:5555', { PAYPAL_CLIENT_SECRET: 'real-secret', DATABASE_PATH: 'server/data/reliefrelay.db' });
    expect(env.PAYPAL_API_BASE_URL).toBe('http://127.0.0.1:5555');
    expect(env.PAYPAL_CLIENT_SECRET).not.toBe('real-secret');
    expect(env.PAYPAL_WEBHOOK_ID).toBe('');
    expect(env.DATABASE_PATH).not.toMatch(/reliefrelay\.db$/);
    expect(() => judgeDemoEnv('https://api-m.sandbox.paypal.com', {})).toThrow(/loopback/);

    const judge = loadConfig(env);
    expect(judge.paypal.target).toBe('local_stub');
    expect(() => assertJudgeIsolation(judge, ['server/data/reliefrelay.db'])).not.toThrow();
    expect(() => assertJudgeIsolation(judge, [env.DATABASE_PATH!])).toThrow(/separate/);
    const sandbox = loadConfig({ ...env, PAYPAL_API_BASE_URL: 'https://api-m.sandbox.paypal.com' });
    expect(() => assertJudgeIsolation(sandbox, [])).toThrow(/local stub/);
    expect(() => loadConfig({ ...env, PAYPAL_API_BASE_URL: 'https://api-m.paypal.com' })).toThrow(/Live PayPal is not supported/);
  });
});

describe('scripted local stub outcomes', () => {
  it('reports PENDING, then the outcome for the receiver once the delay has passed', async () => {
    let now = 1_000_000;
    const stub = await startPayPalStub({ outcomeFor: judgeOutcomeFor, now: () => now });
    try {
      const token = (await (
        await fetch(`${stub.baseUrl}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from('stub-client-id:stub-client-secret').toString('base64')}` } })
      ).json()) as { access_token: string };
      const auth = { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' };
      const created = (await (
        await fetch(`${stub.baseUrl}/v1/payments/payouts`, {
          method: 'POST',
          headers: { ...auth, 'PayPal-Request-Id': 'req-1' },
          body: JSON.stringify({ sender_batch_header: { sender_batch_id: 'RRS-TEST-1' }, items: [{ recipient_type: 'EMAIL', amount: { value: '1.00', currency: 'GBP' }, receiver: JUDGE_RECEIVERS.RETURNED, sender_item_id: 'i1' }] }),
        })
      ).json()) as { batch_header: { payout_batch_id: string } };
      const batch = async () => (await (await fetch(`${stub.baseUrl}/v1/payments/payouts/${created.batch_header.payout_batch_id}`, { headers: auth })).json()) as {
        batch_header: { batch_status: string };
        items: { transaction_status: string }[];
      };
      expect((await batch()).items[0]!.transaction_status).toBe('PENDING');
      expect((await batch()).batch_header.batch_status).toBe('PROCESSING');
      now += JUDGE_SETTLE_MS;
      expect((await batch()).items[0]!.transaction_status).toBe('RETURNED');
      expect((await batch()).batch_header.batch_status).toBe('SUCCESS');
      expect(judgeOutcomeFor('someone@personal.example.com')).toBeNull();
    } finally {
      await stub.close();
    }
  });
});

type Harness = Awaited<ReturnType<typeof startSandboxHarness>>;

/** Creates a Judge Demo case, proposes as the operator and approves as the approver, checking four-eyes on the way. */
async function approveJudgeRecovery(h: Harness, outcome: JudgeOutcome) {
  registerJudgeReceivers(h.temp.db, ORG, h.now());
  const scenario = createJudgeScenario(h.temp.db, { organisationId: ORG, outcome, now: h.now(), requestedBy: 'test' });
  const actions = (await (await fetch(`${h.base(OPERATOR)}/cases/${scenario.caseId}/payment-actions`)).json()) as PaymentActionsResponse;
  expect(actions.reissue.available).toBe(true);
  const created = await post(`${h.base(OPERATOR)}/cases/${scenario.caseId}/proposals`, {
    action: 'reissue',
    reasonCode: actions.reissue.reasonCodes[0],
    justification: 'Receiver re-verified by the programme team.',
    attestation: true,
    caseVersion: actions.case.version,
    providerFingerprint: actions.providerFingerprint,
  });
  expect(created.status).toBe(201);
  const { proposal: summary } = (await created.json()) as ProposalResponse;
  const { proposal } = (await (await fetch(`${h.base(APPROVER)}/proposals/${summary.id}`)).json()) as ProposalResponse;
  expect((await post(`${h.base(OPERATOR)}/proposals/${proposal.id}/approve`, { proposalVersion: proposal.version, confirmation: proposal.confirmationPhrase })).status).toBe(403);
  expect((await post(`${h.base(APPROVER)}/proposals/${proposal.id}/approve`, { proposalVersion: proposal.version, confirmation: 'not it' })).status).toBe(422);
  const approved = await post(`${h.base(APPROVER)}/proposals/${proposal.id}/approve`, { proposalVersion: proposal.version, confirmation: proposal.confirmationPhrase });
  expect(approved.status).toBe(200);
  const recovery = async () =>
    ((await (await fetch(`${h.base(OPERATOR)}/cases/${scenario.caseId}/payment-actions`)).json()) as PaymentActionsResponse).recoveries[0]!;
  return { recovery };
}

describe('Judge Demo four-eyes workflow on the local stub', () => {
  it('proposes as the operator, approves as a different approver, sends to the stub and polls to the outcome', async () => {
    const h = await startSandboxHarness({ outcomeFor: judgeOutcomeFor, allowlist: false });
    try {
      const { recovery } = await approveJudgeRecovery(h, 'FAILED');
      expect((await recovery()).provider?.status).toBe('PENDING');
      h.advance(11 * 60_000);
      await h.payouts.tick();
      expect((await recovery()).provider?.status).toBe('FAILED');
      expect(h.stub.count('create')).toBe(1);
    } finally {
      await h.close();
    }
  });

  it.each(JUDGE_OUTCOMES)('records the terminal batch status once a %s item settles, keeping item and batch separate', async (outcome) => {
    const h = await startSandboxHarness({ outcomeFor: judgeOutcomeFor, allowlist: false });
    try {
      const { recovery } = await approveJudgeRecovery(h, outcome);
      const before = await recovery();
      expect(before.provider?.status).toBe('PENDING');
      expect(['PENDING', 'PROCESSING']).toContain(before.batch.status);

      h.advance(11 * 60_000);
      await h.payouts.tick();
      const after = await recovery();
      expect(after.provider?.status).toBe(outcome);
      expect(after.batch.status).toBe('SUCCESS');
      const batchReads = h.stub.count('get_batch');

      h.advance(11 * 60_000);
      await h.payouts.tick();
      expect(h.stub.count('get_batch')).toBe(batchReads);
      expect(h.stub.count('create')).toBe(1);
      expect(verifyAuditChain(h.temp.db).ok).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('leaves the batch status unchanged when the provider batch read fails', async () => {
    const h = await startSandboxHarness({ outcomeFor: judgeOutcomeFor, allowlist: false });
    try {
      const { recovery } = await approveJudgeRecovery(h, 'SUCCESS');
      const before = (await recovery()).batch.status;
      h.stub.faults.get_batch.push({ kind: 'status', status: 500 });
      h.advance(11 * 60_000);
      await h.payouts.tick();
      const after = await recovery();
      expect(after.provider?.status).toBe('SUCCESS');
      expect(after.batch.status).toBe(before);

      h.advance(11 * 60_000);
      await h.payouts.tick();
      expect((await recovery()).batch.status).toBe('SUCCESS');
    } finally {
      await h.close();
    }
  });

  it('never rewrites an item status from a batch status read', async () => {
    const h = await startSandboxHarness({ outcomeFor: judgeOutcomeFor, allowlist: false });
    try {
      const { recovery } = await approveJudgeRecovery(h, 'RETURNED');
      h.advance(11 * 60_000);
      await h.payouts.tick();
      const settled = await recovery();
      expect(settled.provider?.status).toBe('RETURNED');
      const checks = (h.temp.db.prepare('SELECT COUNT(*) AS n FROM provider_status_checks').get() as { n: number }).n;
      h.temp.db.prepare("UPDATE payment_batches SET provider_status = 'PROCESSING' WHERE id = (SELECT recovery_batch_id FROM payout_submissions)").run();
      h.advance(11 * 60_000);
      await h.payouts.tick();
      const after = await recovery();
      expect(after.batch.status).toBe('SUCCESS');
      expect(after.provider?.status).toBe('RETURNED');
      expect(after.provider?.statusUpdatedAt).toBe(settled.provider?.statusUpdatedAt);
      expect((h.temp.db.prepare('SELECT COUNT(*) AS n FROM provider_status_checks').get() as { n: number }).n).toBe(checks);
    } finally {
      await h.close();
    }
  });
});

describe('Judge Demo restarts and explicit reset', () => {
  const NOW = new Date('2026-11-12T15:00:00.000Z');
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

  it('creates a missing database, keeps an existing one by default and resets only on request', () => {
    expect(decideJudgeStart({ exists: false, reset: false, force: false, lastActivity: null, now: NOW })).toEqual({ action: 'create' });
    expect(decideJudgeStart({ exists: true, reset: false, force: false, lastActivity: minutesAgo(1), now: NOW })).toEqual({ action: 'keep' });
    expect(decideJudgeStart({ exists: true, reset: true, force: false, lastActivity: null, now: NOW })).toEqual({ action: 'reset' });
    expect(decideJudgeStart({ exists: true, reset: true, force: false, lastActivity: minutesAgo(45), now: NOW })).toEqual({ action: 'reset' });
  });

  it('refuses a reset within 30 minutes of judge activity unless forced', () => {
    expect(() => decideJudgeStart({ exists: true, reset: true, force: false, lastActivity: minutesAgo(12), now: NOW })).toThrow(/12 minutes ago/);
    expect(decideJudgeStart({ exists: true, reset: true, force: true, lastActivity: minutesAgo(12), now: NOW })).toEqual({ action: 'reset' });
  });

  it('reads the last action by a demo identity, ignoring system entries', async () => {
    const h = await startSandboxHarness({ outcomeFor: judgeOutcomeFor, allowlist: false });
    try {
      registerJudgeReceivers(h.temp.db, ORG, h.now());
      createJudgeScenario(h.temp.db, { organisationId: ORG, outcome: 'SUCCESS', now: h.now(), requestedBy: 'setup' });
      const before = lastJudgeActivity(h.temp.db);
      await approveJudgeRecovery(h, 'SUCCESS');
      const after = lastJudgeActivity(h.temp.db);
      expect(after).not.toBeNull();
      expect(before === null || after!.getTime() >= before.getTime()).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('detects a running Judge Demo API so a reset can refuse to delete a database in use', async () => {
    const running = createServer().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => running.once('listening', resolve));
    const port = (running.address() as AddressInfo).port;
    expect(await portInUse(port)).toBe(true);
    await new Promise<void>((resolve) => running.close(() => resolve()));
    expect(await portInUse(port)).toBe(false);
  });

  it('keeps the identity-signing secret across restarts until it is removed by a reset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-judge-key-'));
    try {
      const key = join(dir, 'judge-demo.key');
      const first = loadOrCreateIdentitySecret(key);
      expect(first.length).toBe(32);
      expect(loadOrCreateIdentitySecret(key).equals(first)).toBe(true);
      const value = createIdentitySigner(first).sign('usr_samuel');
      expect(createIdentitySigner(loadOrCreateIdentitySecret(key)).verify(value)).toBe('usr_samuel');
      removeJudgeDemoFiles(join(dir, 'missing.db'), key);
      expect(loadOrCreateIdentitySecret(key).equals(first)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives a restarted stub back its recorded payouts, resuming a pending item, without duplicates', async () => {
    const h = await startSandboxHarness({ outcomeFor: judgeOutcomeFor, allowlist: false });
    const restarted = await startPayPalStub({ outcomeFor: judgeOutcomeFor, now: () => h.now().getTime() });
    try {
      const { recovery } = await approveJudgeRecovery(h, 'UNCLAIMED');
      const pending = await recovery();
      const itemId = pending.provider!.providerItemId!;
      const sub = h.temp.db.prepare('SELECT provider_batch_id, sender_batch_id FROM payout_submissions').get() as { provider_batch_id: string; sender_batch_id: string };

      expect(restoreStubPayouts(h.temp.db, restarted)).toBe(1);
      expect(restoreStubPayouts(h.temp.db, restarted)).toBe(1);
      expect(restarted.batches.get(sub.provider_batch_id)?.items).toHaveLength(1);
      expect(restarted.batches.get(sub.provider_batch_id)?.sender_batch_id).toBe(sub.sender_batch_id);

      const client = createPayPalClient({ baseUrl: restarted.baseUrl, clientId: 'stub-client-id', clientSecret: 'stub-client-secret', clock: h.now });
      const early = await client.getItem(itemId);
      expect((early.body as { transaction_status: string }).transaction_status).toBe('PENDING');
      expect(((await client.getBatch(sub.provider_batch_id)).body as { batch_header: { batch_status: string } }).batch_header.batch_status).toBe('PROCESSING');
      h.advance(JUDGE_SETTLE_MS + 1_000);
      expect(((await client.getItem(itemId)).body as { transaction_status: string }).transaction_status).toBe('UNCLAIMED');
      expect(((await client.getBatch(sub.provider_batch_id)).body as { batch_header: { batch_status: string } }).batch_header.batch_status).toBe('SUCCESS');
      expect(restarted.count('create')).toBe(0);
    } finally {
      await restarted.close();
      await h.close();
    }
  });
});

describe('judge-mode gateway', () => {
  let temp: TempDatabase;
  let server: Server;
  let gateway: Server;
  let gatewayUrl: string;
  let staticDir: string;

  beforeAll(async () => {
    temp = createSeededDatabase();
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: temp.path, PAYMENT_PROVIDER_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'stub-client-id', PAYPAL_CLIENT_SECRET: 'stub-client-secret', PAYPAL_API_BASE_URL: 'http://127.0.0.1:9' });
    const app = createApp({ config, logger: pino({ level: 'silent' }), db: temp.db, demoUserId: DEMO_SESSION_USER_ID, clock: () => TEST_NOW, aiProvider: null, judgeDemo: { signer: createIdentitySigner(), roles: JUDGE_ROLES } });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    staticDir = mkdtempSync(join(tmpdir(), 'rr-judge-gateway-'));
    mkdirSync(join(staticDir, 'assets'));
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><div id="root"></div>');
    gateway = createPublicGateway({ staticDir, apiOrigin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, mode: 'judge' });
    gateway.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => gateway.once('listening', resolve));
    gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    temp.cleanup();
    rmSync(staticDir, { recursive: true, force: true });
  });

  it('forwards reads and app writes, passing back only the signed identity cookie', async () => {
    const s = (await (await fetch(`${gatewayUrl}/api/session`, { headers: { 'x-reliefrelay-public-gateway': '1' } })).json()) as SessionResponse;
    expect(s.environment.judgeDemo).toBe(true);
    expect(s.environment.publicReadOnly).toBe(false);
    const sw = await post(`${gatewayUrl}/api/demo/identity`, { userId: APPROVER }, WRITE);
    expect(sw.status).toBe(200);
    const cookie = sw.headers.getSetCookie()[0]!.split(';')[0]!;
    expect(cookie).toMatch(/^rr_demo_user=usr_samuel\./);
    const asApprover = (await (await fetch(`${gatewayUrl}/api/session`, { headers: { Cookie: `other=1; ${cookie}; tracking=2` } })).json()) as SessionResponse;
    expect(asApprover.user.role).toBe('approver');
  });

  it('blocks administrative endpoints, unknown methods and malformed paths', async () => {
    expect((await post(`${gatewayUrl}/api/integrations/paypal/connection-check`, {}, WRITE)).status).toBe(403);
    for (const path of ['/api/admin', '/api/settings', '/api/allowlist', '/api/receivers', '/api/provider/mode', '/api/credentials']) {
      expect((await post(`${gatewayUrl}${path}`, {}, WRITE)).status, path).toBe(403);
    }
    for (const method of ['DELETE', 'PATCH', 'OPTIONS']) expect((await fetch(`${gatewayUrl}/api/cases`, { method })).status, method).toBe(405);
    expect((await post(`${gatewayUrl}/api/%69ntegrations/paypal/connection-check`, {}, WRITE)).status).toBe(400);
    expect((await post(`${gatewayUrl}/api//integrations/paypal/connection-check`, {}, WRITE)).status).toBe(400);
    expect((await fetch(`${gatewayUrl}/api/integrations/paypal`)).status).toBe(200);
    expect((await fetch(`${gatewayUrl}/`, { method: 'POST' })).status).toBe(405);
  });

  it('refuses oversized bodies and rate-limits AI investigations per visitor', async () => {
    const big = await fetch(`${gatewayUrl}/api/judge-demo/scenarios`, { method: 'POST', headers: { ...WRITE, 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'x'.repeat(200_000) }) });
    expect(big.status).toBe(413);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await post(`${gatewayUrl}/api/cases/case_missing/investigations`, { caseVersion: 1 }, { ...WRITE, 'cf-connecting-ip': '203.0.113.9' })).status);
    }
    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses[3]).toBe(429);
    expect((await post(`${gatewayUrl}/api/cases/case_missing/investigations`, { caseVersion: 1 }, { ...WRITE, 'cf-connecting-ip': '203.0.113.10' })).status).not.toBe(429);
  });

  it('caps AI investigations per visitor per day, so one visitor cannot use up the shared AI quota', async () => {
    let now = 0;
    const capped = createPublicGateway({ staticDir, apiOrigin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, mode: 'judge', limiter: createRateLimiter(() => now) });
    capped.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => capped.once('listening', resolve));
    const url = `http://127.0.0.1:${(capped.address() as AddressInfo).port}`;
    try {
      const visitor = { ...WRITE, 'cf-connecting-ip': '198.51.100.7' };
      const investigate = () => post(`${url}/api/cases/case_missing/investigations`, { caseVersion: 1 }, visitor);
      const statuses: number[] = [];
      for (let burst = 0; burst < 3; burst += 1) {
        for (let i = 0; i < 3; i += 1) statuses.push((await investigate()).status);
        now += 16 * 60_000;
      }
      expect(statuses.slice(0, 8)).not.toContain(429);
      expect(statuses[8]).toBe(429);
      const refused = await investigate();
      expect(refused.status).toBe(429);
      expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(/AI investigations from you today/);
      expect((await post(`${url}/api/cases/case_missing/investigations`, { caseVersion: 1 }, { ...WRITE, 'cf-connecting-ip': '198.51.100.8' })).status).not.toBe(429);
      now += 24 * 60 * 60_000;
      expect((await investigate()).status).not.toBe(429);
    } finally {
      await new Promise<void>((resolve) => capped.close(() => resolve()));
    }
  });

  it('counts only successful payout approvals towards the per-visitor daily cap', async () => {
    let apiStatus = 403;
    const api = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(apiStatus, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    api.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => api.once('listening', resolve));
    const capped = createPublicGateway({ staticDir, apiOrigin: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, mode: 'judge', limiter: createRateLimiter(() => 0) });
    capped.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => capped.once('listening', resolve));
    const url = `http://127.0.0.1:${(capped.address() as AddressInfo).port}`;
    try {
      const approve = () => post(`${url}/api/proposals/prop_x/approve`, { proposalVersion: 1, confirmation: 'x' }, { ...WRITE, 'cf-connecting-ip': '198.51.100.20' });
      for (let i = 0; i < 8; i += 1) expect((await approve()).status).toBe(403);
      apiStatus = 200;
      for (let i = 0; i < 6; i += 1) expect((await approve()).status).toBe(200);
      const refused = await approve();
      expect(refused.status).toBe(429);
      expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(/payout approvals from you today/);
    } finally {
      await new Promise<void>((resolve) => capped.close(() => resolve()));
      await new Promise<void>((resolve) => api.close(() => resolve()));
    }
  });

  it('starts only in front of the Judge Demo API on the local stub', async () => {
    await expect(assertJudgeApi(new URL(gatewayUrl).origin.replace(/:\d+$/, `:${(server.address() as AddressInfo).port}`))).resolves.toBeUndefined();
  });
});
