import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { InvestigationDetail, InvestigationListResponse } from '@shared/api/contracts';
import { INVESTIGATION_INSTRUCTIONS } from '../ai/prompt';
import { providerFromConfig } from '../app';
import { verifyAuditChain } from '../audit/auditLog';
import { loadConfig } from '../config/env';
import { clone, conflictCaseOutput, failedResponse, okResponse, scriptedProvider } from '../test-support/aiFixtures';
import { createScenario, INJECTION_NOTE, SENSITIVE_FILE_NAME, SENSITIVE_PROGRAMME, type Scenario } from '../test-support/investigationFixtures';
import { completed, json, startOpenAiStub, type OpenAiStub } from '../test-support/openaiStub';
import { startApp, TEST_NOW, type RunningApp } from '../test-support/seededApp';
import { createInvestigationService } from './investigationService';

let scenario: Scenario | undefined;
let app: RunningApp | undefined;
let stub: OpenAiStub | undefined;
afterEach(async () => {
  await app?.close();
  await stub?.close();
  scenario?.temp.cleanup();
  scenario = app = stub = undefined;
});

const PROTECTED_TABLES = [
  'organisations',
  'users',
  'imports',
  'import_rows',
  'import_row_results',
  'payment_batches',
  'payment_items',
  'provider_transactions',
  'status_observations',
  'payment_cases',
  'reconciliation_findings',
  'case_findings',
  'case_notes',
  'payment_events',
];

function snapshotProtected(s: Scenario): string {
  return JSON.stringify(PROTECTED_TABLES.map((t) => s.temp.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
}

const caseVersion = (s: Scenario, caseId: string) => (s.temp.db.prepare('SELECT version FROM payment_cases WHERE id = ?').get(caseId) as { version: number }).version;
const count = (s: Scenario, where: string) => (s.temp.db.prepare(`SELECT count(*) AS n FROM ${where}`).get() as { n: number }).n;

async function setup(options: { provider?: NonNullable<Parameters<typeof startApp>[3]>['aiProvider']; user?: string; env?: NodeJS.ProcessEnv; logger?: pino.Logger } = {}) {
  scenario = await createScenario();
  app = await startApp(scenario.temp, options.user, options.env, {
    ...('provider' in options ? { aiProvider: options.provider } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return { s: scenario, base: app.baseUrl };
}

const post = (base: string, caseId: string, version: number, signal?: AbortSignal) =>
  fetch(`${base}/cases/${caseId}/investigations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseVersion: version }), signal });
const list = async (base: string, caseId: string) => (await (await fetch(`${base}/cases/${caseId}/investigations`)).json()) as InvestigationListResponse;

describe('running an investigation', () => {
  it('stores the exact evidence snapshot sent to the model with the validated result', async () => {
    const provider = scriptedProvider(okResponse(conflictCaseOutput()));
    const { s, base } = await setup({ provider });
    const response = await post(base, s.conflictCaseId, caseVersion(s, s.conflictCaseId));
    expect(response.status).toBe(201);
    const detail = (await response.json()) as InvestigationDetail;
    expect(detail).toMatchObject({ status: 'succeeded', failure: null, model: 'gpt-6.1-sol-2026-10-01', evidenceChanged: false, requestedBy: { id: 'usr_lena' } });
    expect(detail.result?.nextSteps.every((step) => step.requiresHumanAuthorisation === false)).toBe(true);
    expect(detail.evidence.find((e) => e.id === 'PRV1')?.source).toMatchObject({ type: 'provider_record' });
    expect(detail.evidence.find((e) => e.id === 'OBS1')?.source).toMatchObject({ type: 'observation' });

    const row = s.temp.db.prepare('SELECT * FROM case_investigations WHERE id = ?').get(detail.id) as Record<string, unknown>;
    expect(row.evidence_pack).toBe(provider.requests[0]!.evidence);
    expect(row).toMatchObject({ status: 'succeeded', model_requested: 'gpt-6.1-sol', model_reported: 'gpt-6.1-sol-2026-10-01', prompt_version: 'investigation-prompt-v3', input_tokens: 2400, output_tokens: 900 });
    expect(provider.requests[0]!.instructions).toBe(INVESTIGATION_INSTRUCTIONS);

    const actions = (s.temp.db.prepare("SELECT action, outcome FROM audit_events WHERE entity_id = ? AND action LIKE 'case.investigation%' ORDER BY seq").all(s.conflictCaseId) as {
      action: string;
      outcome: string;
    }[]).map((r) => `${r.action}:${r.outcome}`);
    expect(actions).toEqual(['case.investigation_requested:succeeded', 'case.investigation_completed:succeeded']);

    const listed = await list(base, s.conflictCaseId);
    expect(listed.latestSucceeded?.id).toBe(detail.id);
    expect(listed.investigations).toHaveLength(1);
    expect(listed.availability).toMatchObject({ configured: true, canRun: true, usedToday: 1, dailyLimit: 50 });
    expect(verifyAuditChain(s.temp.db).ok).toBe(true);
  });

  it('never sends receivers, recipient references, names, notes, file names or programmes to the provider', async () => {
    const provider = scriptedProvider(failedResponse('refused'));
    const { s, base } = await setup({ provider });
    for (const caseId of [s.conflictCaseId, s.importedOnlyCaseId, s.injectionCaseId, s.providerCaseId]) {
      expect((await post(base, caseId, caseVersion(s, caseId))).status).toBe(201);
    }
    const sent = JSON.stringify(provider.requests);
    const fromDb = (sql: string) => (s.temp.db.prepare(sql).all() as { v: string }[]).map((r) => r.v);
    for (const value of [
      ...fromDb('SELECT receiver_value AS v FROM payment_items'),
      ...fromDb('SELECT recipient_reference AS v FROM payment_items'),
      ...fromDb('SELECT display_name AS v FROM users'),
      ...fromDb('SELECT body AS v FROM case_notes'),
      ...fromDb('SELECT raw_values AS v FROM import_rows'),
      SENSITIVE_FILE_NAME,
      SENSITIVE_PROGRAMME,
      INJECTION_NOTE,
      s.conflictPayment.recipientReference,
      s.conflictPayment.receiver,
    ]) {
      expect(sent.includes(value), value.slice(0, 40)).toBe(false);
    }
  });

  it('shows when the evidence has changed since the investigation', async () => {
    const { s, base } = await setup({ provider: scriptedProvider(okResponse(conflictCaseOutput())) });
    await post(base, s.conflictCaseId, caseVersion(s, s.conflictCaseId));
    await fetch(`${base}/cases/${s.conflictCaseId}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Checked the export.' }) });
    expect((await list(base, s.conflictCaseId)).investigations[0]!.evidenceChanged).toBe(false);
    await fetch(`${base}/cases/${s.conflictCaseId}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: caseVersion(s, s.conflictCaseId) }) });
    const after = await list(base, s.conflictCaseId);
    expect(after.investigations[0]!.evidenceChanged).toBe(true);
    expect(after.latestSucceeded?.evidenceChanged).toBe(true);
  });
});

describe('failed and hostile responses', () => {
  const hostile = () => {
    const output = clone(conflictCaseOutput());
    output.known[1]!.basis = 'provider_record';
    output.known[1]!.statement = 'The provider confirmed the payment was RETURNED on 2026-11-08.';
    output.nextSteps.push({ id: 'S3', type: 'propose_reissue', action: 'I have approved a reissue to the new account.', relatesTo: ['K2'], informationNeeded: null });
    return output;
  };

  it.each([
    ['hostile output', okResponse(hostile()), 'failed_validation'],
    ['output that is not the schema', okResponse({ verdict: 'pay again', confidence: 0.97 }), 'failed_validation'],
    ['a refusal', failedResponse('refused'), 'refused'],
    ['an incomplete response', failedResponse('incomplete'), 'incomplete'],
    ['a timeout', failedResponse('timeout'), 'timeout'],
    ['a rate limit', failedResponse('rate_limited'), 'rate_limited'],
    ['an unsupported schema', failedResponse('unsupported_schema'), 'unsupported_schema'],
  ] as const)('stores %s as a failed attempt and changes no payment or case data', async (_label, response, failureCode) => {
    const { s, base } = await setup({ provider: scriptedProvider(response) });
    const before = snapshotProtected(s);
    const res = await post(base, s.conflictCaseId, caseVersion(s, s.conflictCaseId));
    expect(res.status).toBe(201);
    const detail = (await res.json()) as InvestigationDetail;
    expect(detail).toMatchObject({ status: 'failed', result: null, failure: { code: failureCode } });
    expect(snapshotProtected(s)).toBe(before);
    expect(s.temp.db.prepare('SELECT result FROM case_investigations WHERE id = ?').get(detail.id)).toEqual({ result: null });
    expect((await list(base, s.conflictCaseId)).latestSucceeded).toBeNull();
  });

  it('rejects the whole hostile response and lists the failed checks without repeating its text', async () => {
    const { s, base } = await setup({ provider: scriptedProvider(okResponse(hostile())) });
    const detail = (await (await post(base, s.conflictCaseId, caseVersion(s, s.conflictCaseId))).json()) as InvestigationDetail;
    expect(detail.validationIssues.map((i) => i.code)).toEqual(expect.arrayContaining(['basis_mismatch', 'recommendation_without_basis', 'policy_action_claim']));
    expect(JSON.stringify(detail)).not.toContain('I have approved');
  });

  it('records a provider that throws as a failure without changing anything', async () => {
    const { s, base } = await setup({
      provider: scriptedProvider(() => {
        throw new Error('socket hang up SECRET');
      }),
    });
    const before = snapshotProtected(s);
    const detail = (await (await post(base, s.conflictCaseId, caseVersion(s, s.conflictCaseId))).json()) as InvestigationDetail;
    expect(detail.failure).toMatchObject({ code: 'provider_unavailable' });
    expect(JSON.stringify(detail)).not.toContain('SECRET');
    expect(snapshotProtected(s)).toBe(before);
  });

  it('keeps a successful investigation separate from case data', async () => {
    const { s, base } = await setup({ provider: scriptedProvider(okResponse(conflictCaseOutput())) });
    const before = snapshotProtected(s);
    expect((await post(base, s.conflictCaseId, caseVersion(s, s.conflictCaseId))).status).toBe(201);
    expect(snapshotProtected(s)).toBe(before);
  });
});

describe('permissions and eligibility', () => {
  it('lets admins run investigations', async () => {
    const { s, base } = await setup({ provider: scriptedProvider(okResponse(conflictCaseOutput())), user: 'usr_priya' });
    expect((await post(base, s.conflictCaseId, caseVersion(s, s.conflictCaseId))).status).toBe(201);
  });

  it.each([
    ['usr_samuel', 'approver'],
    ['usr_tomas', 'viewer'],
  ])('lets %s (%s) read investigations but not run them', async (user, role) => {
    const { s, base } = await setup({ provider: scriptedProvider(okResponse(conflictCaseOutput())), user });
    const listed = await list(base, s.conflictCaseId);
    expect(listed.availability).toMatchObject({ canRun: false, reason: 'Only operators and administrators can run an investigation.' });
    expect((await post(base, s.conflictCaseId, caseVersion(s, s.conflictCaseId))).status).toBe(403);
    expect(count(s, 'case_investigations')).toBe(0);
    const refusal = s.temp.db.prepare("SELECT outcome, actor_role FROM audit_events WHERE action = 'case.investigation_requested'").get();
    expect(refusal).toEqual({ outcome: 'rejected', actor_role: role });
  });

  it('refuses resolved and closed cases', async () => {
    const { s, base } = await setup({ provider: scriptedProvider(okResponse(conflictCaseOutput())) });
    for (const caseId of [s.resolvedCaseId, 'case_1042']) {
      const res = await post(base, caseId, caseVersion(s, caseId));
      expect(res.status).toBe(422);
      expect((await list(base, caseId)).availability.reason).toMatch(/Resolved and closed/);
    }
    expect(count(s, 'case_investigations')).toBe(0);
  });

  it('refuses a request based on a stale case version', async () => {
    const { s, base } = await setup({ provider: scriptedProvider(okResponse(conflictCaseOutput())) });
    const res = await post(base, s.conflictCaseId, caseVersion(s, s.conflictCaseId) + 1);
    expect(res.status).toBe(409);
    expect(count(s, 'case_investigations')).toBe(0);
  });

  it('reports that AI is unavailable when no provider is configured', async () => {
    const { s, base } = await setup({ provider: null });
    expect((await list(base, s.conflictCaseId)).availability).toMatchObject({ configured: false, canRun: false, model: null });
    const res = await post(base, s.conflictCaseId, caseVersion(s, s.conflictCaseId));
    expect(res.status).toBe(503);
    expect(count(s, 'case_investigations')).toBe(0);
  });

  it('returns 404 for an investigation that belongs to another case', async () => {
    const { s, base } = await setup({ provider: scriptedProvider(okResponse(conflictCaseOutput())) });
    const detail = (await (await post(base, s.conflictCaseId, caseVersion(s, s.conflictCaseId))).json()) as InvestigationDetail;
    expect((await fetch(`${base}/cases/${s.conflictCaseId}/investigations/${detail.id}`)).status).toBe(200);
    expect((await fetch(`${base}/cases/${s.providerCaseId}/investigations/${detail.id}`)).status).toBe(404);
  });
});

describe('cost guards', () => {
  it('allows one investigation in progress per case', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => (release = done));
    const { s, base } = await setup({
      provider: scriptedProvider(async () => {
        await gate;
        return okResponse(conflictCaseOutput());
      }),
    });
    const version = caseVersion(s, s.conflictCaseId);
    const first = post(base, s.conflictCaseId, version);
    await expect.poll(() => count(s, "case_investigations WHERE status = 'pending'")).toBe(1);
    const second = await post(base, s.conflictCaseId, version);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('in_progress');
    expect((await list(base, s.conflictCaseId)).availability.reason).toMatch(/in progress/);
    release();
    expect((await first).status).toBe(201);
  });

  it('enforces the daily organisation limit and counts failed attempts', async () => {
    const { s, base } = await setup({ provider: scriptedProvider(failedResponse('provider_unavailable')), env: { AI_DAILY_INVESTIGATION_LIMIT: '2' } });
    expect((await post(base, s.conflictCaseId, caseVersion(s, s.conflictCaseId))).status).toBe(201);
    expect((await post(base, s.importedOnlyCaseId, caseVersion(s, s.importedOnlyCaseId))).status).toBe(201);
    const third = await post(base, s.providerCaseId, caseVersion(s, s.providerCaseId));
    expect(third.status).toBe(429);
    expect((await list(base, s.providerCaseId)).availability).toMatchObject({ canRun: false, usedToday: 2, dailyLimit: 2 });
    expect(count(s, 'case_investigations')).toBe(2);
  });

  it('keeps the daily limit atomic when several processes start investigations at once', async () => {
    scenario = await createScenario();
    const s = scenario;
    const tsx = resolve('node_modules/tsx/dist/cli.mjs');
    const worker = resolve('server/src/test-support/investigationWorker.ts');
    const startAt = String(Date.now() + 2000);
    const caseIds = [s.conflictCaseId, s.importedOnlyCaseId, s.injectionCaseId, s.providerCaseId];
    const run = (caseId: string) =>
      new Promise<{ ok: boolean; code?: string }>((done, fail) => {
        const child = spawn(process.execPath, [tsx, '--tsconfig', 'server/tsconfig.json', worker, s.temp.path, caseId, String(caseVersion(s, caseId)), '1', startAt], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
        child.on('error', fail);
        child.on('close', (code) => (code === 0 && out ? done(JSON.parse(out)) : fail(new Error(`worker exited ${code}: ${err}`))));
      });
    const results = await Promise.all(caseIds.map(run));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => r.code)).toEqual(['too_many_requests', 'too_many_requests', 'too_many_requests']);
    expect(count(s, 'case_investigations')).toBe(1);
    expect(verifyAuditChain(s.temp.db).ok).toBe(true);
  }, 40_000);
});

describe('resilience', () => {
  it('completes a recorded attempt when the browser disconnects', async () => {
    const { s, base } = await setup({
      provider: scriptedProvider(async () => {
        await new Promise((done) => setTimeout(done, 300));
        return okResponse(conflictCaseOutput());
      }),
    });
    const controller = new AbortController();
    const request = post(base, s.conflictCaseId, caseVersion(s, s.conflictCaseId), controller.signal).catch((e: unknown) => e);
    await expect.poll(() => count(s, "case_investigations WHERE status = 'pending'")).toBe(1);
    controller.abort();
    expect(await request).toBeInstanceOf(Error);
    await expect.poll(() => count(s, "case_investigations WHERE status = 'succeeded'"), { timeout: 3000 }).toBe(1);
    expect(verifyAuditChain(s.temp.db).ok).toBe(true);
  });

  it('marks attempts left pending by a stopped server as interrupted', async () => {
    scenario = await createScenario();
    const s = scenario;
    let finish: () => void = () => undefined;
    const hanging = createInvestigationService({
      db: s.temp.db,
      clock: () => TEST_NOW,
      provider: scriptedProvider(() => new Promise((done) => (finish = () => done(failedResponse('timeout'))))),
      dailyLimit: 50,
      timeoutMs: 45_000,
    });
    const abandoned = hanging.run(s.ctx, s.conflictCaseId, caseVersion(s, s.conflictCaseId));
    await expect.poll(() => count(s, "case_investigations WHERE status = 'pending'")).toBe(1);

    const restarted = createInvestigationService({ db: s.temp.db, clock: () => TEST_NOW, provider: null, dailyLimit: 50, timeoutMs: 45_000 });
    expect(restarted.recoverInterrupted()).toBe(1);
    expect(s.temp.db.prepare('SELECT status, failure_code FROM case_investigations').get()).toEqual({ status: 'failed', failure_code: 'interrupted' });
    expect(s.temp.db.prepare("SELECT actor_type FROM audit_events WHERE action = 'case.investigation_completed'").get()).toEqual({ actor_type: 'system' });

    finish();
    await abandoned;
    expect(s.temp.db.prepare('SELECT status, failure_code FROM case_investigations').get()).toEqual({ status: 'failed', failure_code: 'interrupted' });
    expect(count(s, "audit_events WHERE action = 'case.investigation_completed'")).toBe(1);
  });

  it('allows only one pending attempt per case at the database level', async () => {
    scenario = await createScenario();
    const s = scenario;
    let finish: () => void = () => undefined;
    const hanging = createInvestigationService({
      db: s.temp.db,
      clock: () => TEST_NOW,
      provider: scriptedProvider(() => new Promise((done) => (finish = () => done(failedResponse('timeout'))))),
      dailyLimit: 50,
      timeoutMs: 45_000,
    });
    const running = hanging.run(s.ctx, s.conflictCaseId, caseVersion(s, s.conflictCaseId));
    await expect.poll(() => count(s, "case_investigations WHERE status = 'pending'")).toBe(1);

    const columns =
      'organisation_id, case_id, case_version, requested_by_user_id, provider, model_requested, prompt_version, schema_version, evidence_pack, evidence_fingerprint, evidence_count, evidence_sources';
    expect(() =>
      s.temp.db.prepare(`INSERT INTO case_investigations (id, ${columns}) SELECT 'inv_duplicate', ${columns} FROM case_investigations WHERE status = 'pending'`).run(),
    ).toThrow(/UNIQUE constraint failed/);

    finish();
    await running;
  });

  it('cannot rewrite or delete a recorded attempt', async () => {
    const { s, base } = await setup({ provider: scriptedProvider(okResponse(conflictCaseOutput())) });
    const detail = (await (await post(base, s.conflictCaseId, caseVersion(s, s.conflictCaseId))).json()) as InvestigationDetail;
    expect(() => s.temp.db.prepare("UPDATE case_investigations SET result = '{}' WHERE id = ?").run(detail.id)).toThrow(/pending to a final status/);
    expect(() => s.temp.db.prepare('DELETE FROM case_investigations WHERE id = ?').run(detail.id)).toThrow(/cannot be deleted/);
  });
});

describe('secrets and logging', () => {
  const KEY = 'sk-test-integration-key-must-not-leak';

  it('never builds a real provider during automated tests', () => {
    expect(providerFromConfig(loadConfig({ NODE_ENV: 'test', OPENAI_API_KEY: KEY }))).toBeNull();
    expect(providerFromConfig(loadConfig({ NODE_ENV: 'test', OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'http://127.0.0.1:9/v1' }))).not.toBeNull();
    expect(() => loadConfig({ NODE_ENV: 'test', OPENAI_BASE_URL: 'http://api.example.com/v1' })).toThrow(/HTTPS/);
    expect(loadConfig({ NODE_ENV: 'test' }).openai).toMatchObject({ model: 'gpt-6.1-sol', timeoutMs: 45_000, dailyLimit: 50 });
  });

  it('keeps the API key, prompt, evidence and provider error text out of responses and logs', async () => {
    stub = await startOpenAiStub(
      completed(conflictCaseOutput()),
      json(500, { error: { message: `server exploded SECRET-PROVIDER-TEXT ${KEY}` } }),
      json(500, { error: { message: `server exploded SECRET-PROVIDER-TEXT ${KEY}` } }),
    );
    const lines: string[] = [];
    const logger = pino(
      { level: 'trace' },
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(chunk.toString());
          done();
        },
      }),
    );
    const { s, base } = await setup({ env: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: stub.baseUrl }, logger });
    const ok = (await (await post(base, s.conflictCaseId, caseVersion(s, s.conflictCaseId))).json()) as InvestigationDetail;
    expect(ok.status).toBe('succeeded');
    const failed = (await (await post(base, s.importedOnlyCaseId, caseVersion(s, s.importedOnlyCaseId))).json()) as InvestigationDetail;
    expect(failed.failure).toMatchObject({ code: 'provider_unavailable' });
    expect(stub.requests).toHaveLength(3);

    const responses = [
      JSON.stringify(ok),
      JSON.stringify(failed),
      await (await fetch(`${base}/session`)).text(),
      await (await fetch(`${base}/cases/${s.conflictCaseId}/investigations`)).text(),
    ].join('\n');
    const logs = lines.join('\n');
    expect(logs).toContain('Investigation attempt finished');
    for (const secret of [KEY, 'SECRET-PROVIDER-TEXT']) {
      expect(responses).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    expect(responses).not.toContain(INVESTIGATION_INSTRUCTIONS.slice(0, 60));
    for (const fragment of [INVESTIGATION_INSTRUCTIONS.slice(0, 60), '"packVersion"', '"evidence"', 'RR-B-2026-014-0001']) expect(logs).not.toContain(fragment);
  });
});
