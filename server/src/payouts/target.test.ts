import { afterEach, describe, expect, it } from 'vitest';
import type { PaymentActionsResponse, ProposalResponse, SessionResponse } from '@shared/api/contracts';
import { ConfigError } from '../config/env';
import { createSeededDatabase } from '../test-support/seededApp';
import { APPROVER, OPERATOR, post, startSandboxHarness, type SandboxHarness } from '../test-support/sandboxHarness';
import type { TempDatabase } from '../test-support/tempDb';
import { bindPayPalTarget, boundPayPalTarget, targetRecordFields } from './target';

const AT = '2026-11-10T12:00:00.000Z';
let temp: TempDatabase | null = null;
let h: SandboxHarness | null = null;
afterEach(async () => {
  temp?.cleanup();
  temp = null;
  await h?.close();
  h = null;
});

describe('PayPal target binding', () => {
  it('binds a database to one target on first use and never lets it change', () => {
    temp = createSeededDatabase();
    expect(boundPayPalTarget(temp.db)).toBeNull();
    expect(bindPayPalTarget(temp.db, 'paypal_sandbox', 'https://api-m.sandbox.paypal.com', AT)).toBe('paypal_sandbox');
    expect(bindPayPalTarget(temp.db, 'paypal_sandbox', 'https://api-m.sandbox.paypal.com', AT)).toBe('paypal_sandbox');
    expect(() => bindPayPalTarget(temp!.db, 'local_stub', 'http://127.0.0.1:4010', AT)).toThrow(ConfigError);
    expect(() => temp!.db.prepare("UPDATE paypal_target_binding SET target = 'local_stub'").run()).toThrow(/cannot change/);
    expect(() => temp!.db.prepare('DELETE FROM paypal_target_binding').run()).toThrow(/cannot change/);
    expect(() => temp!.db.prepare("INSERT INTO paypal_target_binding VALUES (2, 'local_stub', 'x', ?)").run(AT)).toThrow();
    expect(temp.db.prepare('SELECT target, api_host FROM paypal_target_binding').all()).toEqual([{ target: 'paypal_sandbox', api_host: 'api-m.sandbox.paypal.com' }]);
  });

  it('stores genuine PayPal Sandbox records as sandbox data and local-stub records as simulated', () => {
    expect(targetRecordFields('paypal_sandbox')).toEqual({ eventSource: 'sandbox', batchProviderMode: 'sandbox', recoveryProgramme: 'PayPal Sandbox recovery' });
    expect(targetRecordFields('local_stub')).toEqual({ eventSource: 'simulation', batchProviderMode: null, recoveryProgramme: 'Local PayPal stub recovery (test only)' });
  });

  it('refuses a stub database for the real PayPal Sandbox, and payment actions recorded before the binding existed', async () => {
    h = await startSandboxHarness();
    expect(boundPayPalTarget(h.temp.db)).toBe('local_stub');
    const session = (await (await fetch(`${h.base(OPERATOR)}/session`)).json()) as SessionResponse;
    expect(session.environment.paypalTarget).toBe('local_stub');
    expect(session.environment.paypal.detail).toMatch(/^Local PayPal stub at 127\.0\.0\.1:\d+: .*Nothing is sent to PayPal/);
    expect(() => bindPayPalTarget(h!.temp.db, 'paypal_sandbox', 'https://api-m.sandbox.paypal.com', AT)).toThrow(/local PayPal stub/);

    const scenario = h.scenario();
    const actions = (await (await fetch(`${h.base(OPERATOR)}/cases/${scenario.caseId}/payment-actions`)).json()) as PaymentActionsResponse;
    const created = await post(`${h.base(OPERATOR)}/cases/${scenario.caseId}/proposals`, {
      action: 'reissue',
      reasonCode: 'returned_unclaimed',
      justification: 'Simulated RETURNED record; checking the target binding.',
      attestation: true,
      caseVersion: actions.case.version,
      providerFingerprint: actions.providerFingerprint,
    });
    const proposal = ((await created.json()) as ProposalResponse).proposal;
    const approval = await post(`${h.base(APPROVER)}/proposals/${proposal.id}/approve`, { proposalVersion: proposal.version, confirmation: proposal.confirmationPhrase });
    expect(approval.status).toBe(200);

    // A database from before the binding existed: its payment actions cannot be attributed to either target.
    h.temp.db.exec('DROP TRIGGER paypal_target_binding_no_delete; DELETE FROM paypal_target_binding;');
    expect(() => bindPayPalTarget(h!.temp.db, 'paypal_sandbox', 'https://api-m.sandbox.paypal.com', AT)).toThrow(/recorded before/);
    expect(() => bindPayPalTarget(h!.temp.db, 'local_stub', 'http://127.0.0.1:4010', AT)).toThrow(/recorded before/);
  });
});
