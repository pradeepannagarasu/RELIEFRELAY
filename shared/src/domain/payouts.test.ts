import { describe, expect, it } from 'vitest';
import {
  confirmationPhrase,
  forPayPalTarget,
  forPayPalTargetDeep,
  isPayoutCurrency,
  PAYPAL_TARGET_INFO,
  parsePayPalAmount,
  PROPOSAL_ACTION_INFO,
  PROPOSAL_REASON_INFO,
  recoverySenderItemId,
  SANDBOX_NOTICE,
  SANDBOX_RESULT_SUFFIX,
  SENDER_ITEM_ID_MAX_LENGTH,
  SUBMISSION_STATE_INFO,
  toPayPalAmount,
} from './payouts';

describe('PayPal target wording', () => {
  it('leaves genuine PayPal Sandbox text unchanged', () => {
    for (const text of [SUBMISSION_STATE_INFO.accepted.label, SANDBOX_NOTICE, `Recovered in PayPal Sandbox. ${SANDBOX_RESULT_SUFFIX}`]) {
      expect(forPayPalTarget(text, 'paypal_sandbox')).toBe(text);
      expect(forPayPalTarget(text, null)).toBe(text);
    }
  });

  it('never lets a local-stub answer read as a PayPal Sandbox result', () => {
    const cases: [string, string][] = [
      ['Accepted by PayPal Sandbox', 'Accepted by the local PayPal stub'],
      ['PayPal Sandbox', 'Local PayPal stub'],
      ['PayPal Sandbox accepted the payout batch.', 'The local PayPal stub accepted the payout batch.'],
      ['PayPal Sandbox batch ID', 'Local PayPal stub batch ID'],
      ['There is no PayPal Sandbox recovery payout to cancel.', 'There is no local PayPal stub recovery payout to cancel.'],
      ['Approved. PayPal Sandbox reports X as SUCCESS.', 'Approved. The local PayPal stub reports X as SUCCESS.'],
      ['Cancellation confirmed: PayPal Sandbox shows X as RETURNED.', 'Cancellation confirmed: The local PayPal stub shows X as RETURNED.'],
      ['Sent to PayPal Sandbox (approval).', 'Sent to the local PayPal stub (approval).'],
      ['The PayPal Sandbox record', 'The local PayPal stub record'],
      [SANDBOX_NOTICE, PAYPAL_TARGET_INFO.local_stub.notice],
    ];
    for (const [input, expected] of cases) expect(forPayPalTarget(input, 'local_stub')).toBe(expected);
    for (const action of Object.values(PROPOSAL_ACTION_INFO)) {
      expect(forPayPalTarget(`${action.label} ${action.description}`, 'local_stub')).not.toMatch(/Sandbox/);
    }
    expect(forPayPalTarget(PROPOSAL_ACTION_INFO.cancel_unclaimed.label, 'local_stub')).toBe('Cancel the unclaimed local PayPal stub payout');
    const suffixed = forPayPalTarget(`Recovered in PayPal Sandbox. ${SANDBOX_RESULT_SUFFIX}`, 'local_stub');
    expect(suffixed).toBe('Recovered in the local PayPal stub. Local stub test response: nothing was sent to PayPal and no PayPal transaction exists.');
  });

  it('rewords every string in a response body for the stub only', () => {
    const body = { label: 'Accepted by PayPal Sandbox', nested: [{ detail: 'From PayPal Sandbox.' }], count: 2, flag: true, none: null };
    expect(forPayPalTargetDeep(body, 'paypal_sandbox')).toBe(body);
    expect(forPayPalTargetDeep(body, 'local_stub')).toEqual({ label: 'Accepted by the local PayPal stub', nested: [{ detail: 'From the local PayPal stub.' }], count: 2, flag: true, none: null });
  });
});

describe('payout amounts', () => {
  it('formats integer minor units with integer arithmetic only', () => {
    expect(toPayPalAmount(1)).toBe('0.01');
    expect(toPayPalAmount(1250)).toBe('12.50');
    expect(toPayPalAmount(50_000)).toBe('500.00');
    expect(toPayPalAmount(1_000_000_007)).toBe('10000000.07');
    for (const bad of [0, -1, 12.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => toPayPalAmount(bad)).toThrow(RangeError);
  });

  it('parses only exact two-decimal amounts from PayPal', () => {
    expect(parsePayPalAmount('12.50')).toBe(1250);
    expect(parsePayPalAmount('0.01')).toBe(1);
    for (const bad of ['12.5', '12', '12.500', '-1.00', '1e3', ' 12.50', '12,50', 12.5, null]) expect(parsePayPalAmount(bad)).toBeNull();
  });
});

describe('currencies', () => {
  it('accepts only GBP, USD and EUR', () => {
    expect(['GBP', 'USD', 'EUR'].every(isPayoutCurrency)).toBe(true);
    for (const bad of ['gbp', 'JPY', 'BTC', '', null, 826]) expect(isPayoutCurrency(bad)).toBe(false);
  });
});

describe('proposals', () => {
  it('builds the exact confirmation text an approver types', () => {
    expect(confirmationPhrase('reissue', 'RR-P-1044', 12_000, 'GBP')).toBe('RR-P-1044 120.00 GBP');
    expect(confirmationPhrase('cancel_unclaimed', 'RR-P-1044-R1', 12_000, 'GBP')).toBe('CANCEL RR-P-1044-R1');
  });

  it('numbers recovery sender item IDs within the PayPal limit', () => {
    expect(recoverySenderItemId('RR-P-1044', 2)).toBe('RR-P-1044-R2');
    expect(recoverySenderItemId('X'.repeat(59), 3).length).toBeLessThanOrEqual(SENDER_ITEM_ID_MAX_LENGTH);
  });

  it('ties every reason code to exactly the actions it can justify', () => {
    for (const info of Object.values(PROPOSAL_REASON_INFO)) expect(info.actions.length).toBeGreaterThan(0);
    expect(PROPOSAL_REASON_INFO.returned_unclaimed.actions).toEqual(['reissue']);
    expect(PROPOSAL_REASON_INFO.recipient_cannot_claim.actions).toEqual(['cancel_unclaimed']);
  });
});
