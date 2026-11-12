import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DemoIdentitiesResponse, PaymentActionsResponse, ProposalResponse } from '@shared/api/contracts';
import type { EvidencePack, InvestigationOutput } from '@shared/domain/investigation';
import { buildEvidencePack } from '../ai/evidencePack';
import { validateInvestigationOutput } from '../ai/validator';
import { createApp } from '../app';
import { loadConfig } from '../config/env';
import { clone, providerCaseOutput } from '../test-support/aiFixtures';
import { createScenario, type Scenario } from '../test-support/investigationFixtures';
import { APPROVER, OPERATOR, ORG, post, SANDBOX_RECEIVER, startSandboxHarness, type SandboxHarness } from '../test-support/sandboxHarness';
import { createSeededDatabase, TEST_NOW } from '../test-support/seededApp';
import type { TempDatabase } from '../test-support/tempDb';
import { addEntry, deactivateEntry } from './allowlist';
import { createDemoScenario, DEMO_PROGRAMME } from './demoScenario';

const golden = JSON.parse(readFileSync(new URL('../ai/__fixtures__/evidence-fingerprints-before-phase4.json', import.meta.url), 'utf8')) as {
  asOf: string;
  fingerprints: Record<string, string>;
};

function fingerprints(temp: TempDatabase, at = TEST_NOW): Record<string, string> {
  const cases = temp.db.prepare('SELECT id, reference FROM payment_cases WHERE organisation_id = ? ORDER BY reference').all(ORG) as { id: string; reference: string }[];
  return Object.fromEntries(cases.filter((c) => c.reference in golden.fingerprints).map((c) => [c.reference, buildEvidencePack(temp.db, ORG, c.id, at)!.fingerprint]));
}

const seededSnapshot = (temp: TempDatabase) => ({
  cases: temp.db.prepare(`SELECT id, state, version, updated_at, resolved_at FROM payment_cases WHERE reference IN (${Object.keys(golden.fingerprints).map(() => '?').join(',')}) ORDER BY id`).all(...Object.keys(golden.fingerprints)),
  provider: temp.db.prepare("SELECT * FROM provider_transactions WHERE mode = 'simulation' AND payment_item_id NOT IN (SELECT i.id FROM payment_items i JOIN payment_batches b ON b.id = i.batch_id WHERE b.reference LIKE 'RR-B-DEMO-SBX-%') ORDER BY payment_item_id").all(),
  events: temp.db.prepare("SELECT count(*) AS n FROM payment_events WHERE batch_id NOT IN (SELECT id FROM payment_batches WHERE reference LIKE 'RR-B-DEMO-SBX-%' OR kind = 'recovery')").get(),
});

describe('Phase 3 evidence is preserved', () => {
  it('reproduces every seeded case fingerprint captured before Phase 4', () => {
    const temp = createSeededDatabase();
    try {
      expect(golden.asOf).toBe(TEST_NOW.toISOString());
      const now = fingerprints(temp);
      expect(Object.keys(now)).toHaveLength(Object.keys(golden.fingerprints).length);
      expect(now).toEqual(golden.fingerprints);
    } finally {
      temp.cleanup();
    }
  });

  it('adds no Sandbox rule to simulated cases', () => {
    const temp = createSeededDatabase();
    try {
      for (const c of temp.db.prepare('SELECT id FROM payment_cases').all() as { id: string }[]) {
        const pack = buildEvidencePack(temp.db, ORG, c.id, TEST_NOW)!.pack;
        expect(pack.evidence.some((e) => e.kind === 'reference_rule' && e.fields.topic === 'sandbox_mode')).toBe(false);
      }
    } finally {
      temp.cleanup();
    }
  });
});

describe('sandbox:demo-scenario', () => {
  let h: SandboxHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('creates a labelled synthetic payment and case without touching seeded cases or sending anything', async () => {
    h = await startSandboxHarness();
    const before = seededSnapshot(h.temp);
    const result = h.scenario(2500, 'EUR');
    expect(result.batchReference).toBe('RR-B-DEMO-SBX-1');
    expect(result.paymentReference).toBe('RR-P-DEMO-SBX-1');

    const row = h.temp.db
      .prepare(
        `SELECT b.programme, b.provider_mode AS batch_mode, b.sender_batch_id, b.provider_batch_id, p.mode, p.status, p.provider_item_id, i.amount_minor, i.currency, c.state, c.opening_reason
         FROM payment_cases c JOIN payment_items i ON i.id = c.payment_item_id JOIN payment_batches b ON b.id = i.batch_id
         JOIN provider_transactions p ON p.payment_item_id = i.id WHERE c.id = ?`,
      )
      .get(result.caseId) as Record<string, unknown>;
    expect(row).toMatchObject({ programme: DEMO_PROGRAMME, batch_mode: 'simulation', mode: 'simulation', status: 'RETURNED', amount_minor: 2500, currency: 'EUR', state: 'open' });
    expect(row.sender_batch_id).toMatch(/^SIM-/);
    expect(row.provider_batch_id).toMatch(/^SIM-/);
    expect(row.provider_item_id).toMatch(/^SIM-/);
    expect(row.opening_reason).toContain('simulated');
    const events = h.temp.db.prepare('SELECT source, summary FROM payment_events WHERE payment_item_id = (SELECT payment_item_id FROM payment_cases WHERE id = ?)').all(result.caseId) as { source: string; summary: string }[];
    expect(events.every((e) => e.summary.includes('no request was ever sent to PayPal'))).toBe(true);
    expect(events.some((e) => e.source === 'sandbox')).toBe(false);
    expect(h.stub.requests).toEqual([]);
    expect(seededSnapshot(h.temp)).toEqual(before);
  });

  it('accepts only an exact, active allowlist entry and a permitted amount and currency', async () => {
    h = await startSandboxHarness();
    const make = (receiver: string, amountMinor = 1250, currency = 'GBP') =>
      () => createDemoScenario(h!.temp.db, { organisationId: ORG, receiver, amountMinor, currency: currency as 'GBP', now: h!.now() });
    expect(make('sb-demo-recipient+1@personal.example.com')).toThrow(/allowlist/);
    expect(make('recipient@personal.example.com')).toThrow(/allowlist/);
    expect(make('sb-demo-recipient@personal.example.org')).toThrow(/allowlist/);
    expect(make(SANDBOX_RECEIVER, 50_001)).toThrow(/amount/);
    expect(make(SANDBOX_RECEIVER, 0)).toThrow(/amount/);
    expect(make(SANDBOX_RECEIVER, 1250, 'JPY')).toThrow(/currency/);
    deactivateEntry(h.temp.db, ORG, SANDBOX_RECEIVER, 'Rotated test account', h.now());
    expect(make(SANDBOX_RECEIVER)).toThrow(/allowlist/);
    expect(h.temp.db.prepare("SELECT count(*) AS n FROM payment_batches WHERE reference LIKE 'RR-B-DEMO-SBX-%'").get()).toEqual({ n: 0 });
  });

  it('keeps the simulated original separate from the Sandbox recovery, and adds the Sandbox rule only after a Sandbox record exists', async () => {
    h = await startSandboxHarness();
    const before = seededSnapshot(h.temp);
    const scenario = h.scenario();
    const packBefore = buildEvidencePack(h.temp.db, ORG, scenario.caseId, h.now())!.pack;
    const topics = (pack: EvidencePack) => pack.evidence.filter((e) => e.kind === 'reference_rule').map((e) => e.fields.topic);
    expect(topics(packBefore)).toContain('simulation_mode');
    expect(topics(packBefore)).not.toContain('sandbox_mode');

    const actions = (await (await fetch(`${h.base(OPERATOR)}/cases/${scenario.caseId}/payment-actions`)).json()) as PaymentActionsResponse;
    const created = await post(`${h.base(OPERATOR)}/cases/${scenario.caseId}/proposals`, {
      action: 'reissue',
      reasonCode: 'returned_unclaimed',
      justification: 'Simulated RETURNED record; demonstrating one Sandbox reissue for review.',
      attestation: true,
      caseVersion: actions.case.version,
      providerFingerprint: actions.providerFingerprint,
    });
    const proposal = ((await created.json()) as ProposalResponse).proposal;
    const detail = ((await (await fetch(`${h.base(APPROVER)}/proposals/${proposal.id}`)).json()) as ProposalResponse).proposal;
    expect((await post(`${h.base(APPROVER)}/proposals/${proposal.id}/approve`, { proposalVersion: detail.version, confirmation: detail.confirmationPhrase })).status).toBe(200);

    const after = (await (await fetch(`${h.base(OPERATOR)}/cases/${scenario.caseId}/payment-actions`)).json()) as PaymentActionsResponse;
    expect(after.original.provider).toMatchObject({ mode: 'simulation', status: 'RETURNED' });
    expect(after.recoveries).toHaveLength(1);
    expect(after.recoveries[0]!.provider).toMatchObject({ mode: 'sandbox' });
    const batches = h.temp.db
      .prepare('SELECT b.kind, b.provider_mode, b.programme FROM payment_items i JOIN payment_batches b ON b.id = i.batch_id WHERE i.id IN (SELECT payment_item_id FROM payment_cases WHERE id = ?) OR i.recovery_of_item_id IN (SELECT payment_item_id FROM payment_cases WHERE id = ?) ORDER BY b.kind')
      .all(scenario.caseId, scenario.caseId);
    expect(batches).toEqual([
      { kind: 'disbursement', provider_mode: 'simulation', programme: DEMO_PROGRAMME },
      { kind: 'recovery', provider_mode: null, programme: 'Local PayPal stub recovery (test only)' },
    ]);

    const packAfter = buildEvidencePack(h.temp.db, ORG, scenario.caseId, h.now())!.pack;
    expect(topics(packAfter)).toEqual(expect.arrayContaining(['simulation_mode', 'sandbox_mode']));
    expect(seededSnapshot(h.temp)).toEqual(before);
    expect(fingerprints(h.temp)).toEqual(golden.fingerprints);
  });
});

describe('investigation validator with Sandbox evidence', () => {
  let scenario: Scenario;
  let simulated: EvidencePack;
  beforeAll(async () => {
    scenario = await createScenario();
    simulated = buildEvidencePack(scenario.temp.db, scenario.ctx.actor.organisationId, scenario.providerCaseId, TEST_NOW)!.pack;
  });
  afterAll(() => scenario.temp.cleanup());

  const codes = (output: InvestigationOutput, pack: EvidencePack) => {
    const outcome = validateInvestigationOutput(output, pack);
    return outcome.ok ? [] : [...new Set(outcome.issues.map((i) => i.code))];
  };
  /** The simulated pack plus a Sandbox provider record PRV9. */
  const mixed = () => {
    const pack = clone(simulated);
    const prv1 = pack.evidence.find((e) => e.id === 'PRV1')!;
    pack.evidence.push({ ...clone(prv1), id: 'PRV9', origin: 'provider_sandbox', fields: { ...prv1.fields, mode: 'sandbox' } });
    return pack;
  };
  const edit = (change: (o: InvestigationOutput) => void) => {
    const output = clone(providerCaseOutput());
    change(output);
    return output;
  };

  it('accepts PayPal claims qualified as Sandbox and grounded in Sandbox evidence', () => {
    expect(codes(providerCaseOutput(), mixed())).toEqual([]);
    const output = edit((o) => {
      o.known[0] = { ...o.known[0]!, statement: 'According to PayPal Sandbox, the status is RETURNED.', evidenceIds: ['PRV9'], citedValues: [{ evidenceId: 'PRV9', field: 'status', value: 'RETURNED' }] };
    });
    expect(codes(output, mixed())).toEqual([]);
  });

  it('refuses a PayPal claim grounded only in simulated records, even when Sandbox evidence exists', () => {
    const output = edit((o) => {
      o.known[0] = { ...o.known[0]!, statement: 'According to PayPal Sandbox, the status is RETURNED.' };
    });
    expect(codes(output, mixed())).toContain('simulation_presented_as_paypal');
    expect(codes(output, simulated)).toContain('simulation_presented_as_paypal');
  });

  it('refuses unqualified PayPal claims and real-delivery claims when Sandbox evidence exists', () => {
    const unqualified = edit((o) => {
      o.conclusion.summary = 'According to PayPal, the payment was RETURNED (PRV1).';
    });
    expect(codes(unqualified, mixed())).toContain('sandbox_not_qualified');
    const delivered = edit((o) => {
      o.conclusion.summary = 'The PayPal Sandbox record suggests the payout reached the recipient (PRV1).';
    });
    expect(codes(delivered, mixed())).toContain('sandbox_presented_as_real_delivery');
  });
});

describe('development-only role demonstration switcher', () => {
  let temp: TempDatabase | undefined;
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    temp?.cleanup();
    temp = undefined;
  });

  async function start(env: NodeJS.ProcessEnv) {
    temp = createSeededDatabase();
    const config = loadConfig({ DATABASE_PATH: temp.path, ...env });
    const app = createApp({ config, logger: pino({ level: 'silent' }), db: temp.db, demoUserId: OPERATOR, clock: () => TEST_NOW, aiProvider: null });
    server = app.listen(0);
    await new Promise<void>((r) => server!.once('listening', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  }
  const session = async (base: string, cookie?: string) =>
    ((await (await fetch(`${base}/session`, { headers: cookie ? { cookie } : {} })).json()) as { user: { id: string; role: string } }).user;

  it('refuses to start outside development', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_PATH: 'x.db', DEMO_ROLE_SWITCHER: 'true' })).toThrow();
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_PATH: 'x.db', DEMO_ROLE_SWITCHER: 'true' })).toThrow();
  });

  it('is absent when disabled, and the cookie is ignored', async () => {
    const base = await start({ NODE_ENV: 'test' });
    expect((await fetch(`${base}/demo/identities`)).status).toBe(404);
    expect((await session(base, 'rr_demo_user=usr_samuel')).id).toBe(OPERATOR);
  });

  it('switches identity in development only with the app header, and requires the header for writes', async () => {
    const base = await start({ NODE_ENV: 'development', DEMO_ROLE_SWITCHER: 'true' });
    const list = (await (await fetch(`${base}/demo/identities`)).json()) as DemoIdentitiesResponse;
    expect(list.notice).toMatch(/not authentication/);
    expect(list.identities.map((i) => i.id)).toEqual(expect.arrayContaining([OPERATOR, APPROVER]));

    expect((await post(`${base}/demo/identity`, { userId: APPROVER })).status).toBe(403);
    expect((await post(`${base}/demo/identity`, { userId: 'usr_nobody' }, { 'X-ReliefRelay-Demo': '1' })).status).toBe(404);
    const switched = await post(`${base}/demo/identity`, { userId: APPROVER }, { 'X-ReliefRelay-Demo': '1' });
    expect(switched.status).toBe(200);
    const cookie = switched.headers.get('set-cookie')!;
    expect(cookie).toMatch(/rr_demo_user=usr_samuel/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect((await session(base, 'rr_demo_user=usr_samuel')).id).toBe(APPROVER);

    // A write under a switched identity without the app header is refused (a cross-site form cannot add it).
    const caseId = (temp!.db.prepare("SELECT id FROM payment_cases WHERE state = 'open' LIMIT 1").get() as { id: string }).id;
    const noHeader = await fetch(`${base}/cases/${caseId}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: 'rr_demo_user=usr_samuel' }, body: JSON.stringify({ body: 'Checked.' }) });
    expect(noHeader.status).toBe(403);
    expect(temp!.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'demo.identity_switched'").get()).toEqual({ n: 1 });
  });
});

describe('database guards', () => {
  it('refuses phone and real-domain allowlist entries', () => {
    const temp = createSeededDatabase();
    try {
      expect(() => addEntry(temp.db, ORG, 'someone@gmail.com', 'Real address', TEST_NOW)).toThrow();
      expect(() => addEntry(temp.db, ORG, '+447700900123', 'Phone', TEST_NOW)).toThrow();
      expect(() => addEntry(temp.db, ORG, '*@personal.example.com', 'Wildcard', TEST_NOW)).toThrow();
    } finally {
      temp.cleanup();
    }
  });
});
