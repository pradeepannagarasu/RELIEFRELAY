import { describe, expect, it } from 'vitest';
import { deriveNextAction } from './cases';
import { money } from './money';
import { buildOverview, classifyPayment } from './overview';
import type { PayoutItemStatus } from './paypal';
import type { CaseState, PaymentCase, PaymentDataset, PaymentItem } from './types';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function item(
  id: string,
  status: PayoutItemStatus,
  { statusUpdatedAt = daysAgo(1), ...overrides }: Partial<PaymentItem> & { statusUpdatedAt?: string } = {},
): PaymentItem {
  return {
    id,
    batchId: 'bat_1',
    senderItemId: `REF-${id}`,
    recipientReference: `BEN-${id}`,
    recipientType: 'EMAIL',
    recipientMasked: 'a•••1@example.org',
    amount: money('USD', 10000),
    recoveryOfItemId: null,
    provider: {
      mode: 'simulation',
      providerItemId: null,
      providerTransactionId: null,
      status,
      errorCode: null,
      statusUpdatedAt,
    },
    imported: null,
    ...overrides,
  };
}

/** A payment known only from an imported record: the provider has reported nothing. */
function importedItem(id: string, status: PayoutItemStatus, statusAt: string | null = daysAgo(1)): PaymentItem {
  return item(id, status, {
    provider: null,
    imported: { observationId: `obs-${id}`, status, statusAt, errorCode: null, importId: 'imp', rowNumber: 2, recordedAt: daysAgo(0) },
  });
}

function paymentCase(id: string, itemId: string, state: CaseState, overrides: Partial<PaymentCase> = {}): PaymentCase {
  return {
    id,
    reference: `RC-${id}`,
    organisationId: 'org',
    paymentItemId: itemId,
    state,
    basis: 'provider_confirmed',
    openingReason: 'provider_exception',
    openedAt: daysAgo(2),
    updatedAt: daysAgo(1),
    assigneeUserId: null,
    resolution: null,
    version: 1,
    ...overrides,
  };
}

function dataset(items: PaymentItem[], cases: PaymentCase[]): PaymentDataset {
  return {
    organisation: { id: 'org', name: 'Test org', isSynthetic: true },
    users: [],
    batches: [
      {
        id: 'bat_1',
        organisationId: 'org',
        kind: 'disbursement',
        origin: 'provider_submission',
        reference: 'B-1',
        programme: 'Test programme',
        senderBatchId: 'B-1',
        providerBatchId: null,
        providerMode: 'simulation',
        status: 'SUCCESS',
        importedAt: daysAgo(40),
        importedByUserId: 'u',
        submittedAt: daysAgo(40),
        sourceImportId: null,
      },
    ],
    items,
    cases,
    events: [],
  };
}

describe('classifyPayment', () => {
  it('treats provider SUCCESS as delivered', () => {
    expect(classifyPayment(item('a', 'SUCCESS'), undefined, [])).toBe('delivered');
  });

  it('counts a payment as recovered only when a recovery attempt reached SUCCESS', () => {
    const original = item('a', 'RETURNED');
    const resolved = paymentCase('c', 'a', 'resolved');
    expect(classifyPayment(original, resolved, [item('r', 'SUCCESS', { recoveryOfItemId: 'a' })])).toBe('recovered');
    // A case marked resolved without provider confirmation is not trusted.
    expect(classifyPayment(original, resolved, [])).toBe('requires_action');
  });

  it('keeps payments with an in-flight recovery attempt in progress', () => {
    const original = item('a', 'FAILED');
    const attempt = item('r', 'PENDING', { recoveryOfItemId: 'a' });
    expect(classifyPayment(original, paymentCase('c', 'a', 'recovery_submitted'), [attempt])).toBe('in_progress');
  });

  it('separates closed cases from those needing action', () => {
    expect(classifyPayment(item('a', 'FAILED'), paymentCase('c', 'a', 'closed'), [])).toBe('closed_undelivered');
    expect(classifyPayment(item('a', 'UNCLAIMED'), paymentCase('c', 'a', 'open'), [])).toBe('requires_action');
    expect(classifyPayment(item('a', 'PENDING'), undefined, [])).toBe('in_progress');
  });

  it('never counts an imported SUCCESS as delivered without a provider record', () => {
    expect(classifyPayment(importedItem('a', 'SUCCESS'), undefined, [])).toBe('unconfirmed');
    expect(classifyPayment(importedItem('a', 'PENDING'), undefined, [])).toBe('unconfirmed');
  });

  it('treats an imported exception with an active case as requiring action', () => {
    const c = paymentCase('c', 'a', 'open', { basis: 'imported_record', openingReason: 'exception_status_recorded' });
    expect(classifyPayment(importedItem('a', 'FAILED'), c, [])).toBe('requires_action');
    expect(classifyPayment(importedItem('a', 'FAILED'), { ...c, state: 'closed' }, [])).toBe('closed_undelivered');
  });

  it('prefers the provider status over a conflicting imported status', () => {
    const conflicting = item('a', 'SUCCESS', {
      imported: { observationId: 'o', status: 'FAILED', statusAt: null, errorCode: null, importId: 'i', rowNumber: 3, recordedAt: daysAgo(0) },
    });
    expect(classifyPayment(conflicting, undefined, [])).toBe('delivered');
  });
});

describe('buildOverview', () => {
  const items = [
    item('ok1', 'SUCCESS', { amount: money('USD', 5000) }),
    item('ok2', 'SUCCESS', { amount: money('USD', 7000) }),
    item('pend', 'PENDING', { amount: money('USD', 1000) }),
    item('unc-urgent', 'UNCLAIMED', { statusUpdatedAt: daysAgo(25), amount: money('USD', 2000) }),
    item('unc-later', 'UNCLAIMED', { statusUpdatedAt: daysAgo(5), amount: money('USD', 3000) }),
    item('ret', 'RETURNED', { amount: money('USD', 4000) }),
    item('rec', 'SUCCESS', { batchId: 'bat_1', recoveryOfItemId: 'ret', amount: money('USD', 4000) }),
    item('blk', 'BLOCKED', { amount: money('USD', 6000) }),
  ];
  const cases = [
    paymentCase('c1', 'unc-urgent', 'open'),
    paymentCase('c2', 'unc-later', 'awaiting_approval'),
    paymentCase('c3', 'ret', 'resolved'),
    paymentCase('c4', 'blk', 'investigating'),
  ];
  const overview = buildOverview(dataset(items, cases), NOW);

  it('counts intended payments, excluding recovery attempts', () => {
    expect(overview.payments.count).toBe(7);
    expect(overview.payments.value).toEqual([money('USD', 28000)]);
  });

  it('assigns every payment to exactly one outcome', () => {
    const byOutcome = Object.fromEntries(overview.outcomes.map((o) => [o.outcome, o.count]));
    expect(byOutcome).toEqual({ delivered: 2, recovered: 1, in_progress: 1, requires_action: 3, unconfirmed: 0, closed_undelivered: 0 });
    expect(overview.outcomes.reduce((sum, o) => sum + o.count, 0)).toBe(overview.payments.count);
  });

  it('reports outstanding value as in-progress plus requires-action', () => {
    expect(overview.outstanding).toEqual({ count: 4, value: [money('USD', 12000)] });
  });

  it('breaks exceptions down by provider status, largest first', () => {
    expect(overview.exceptionsByStatus.map((s) => [s.status, s.count])).toEqual([
      ['UNCLAIMED', 2],
      ['BLOCKED', 1],
    ]);
  });

  it('flags only unclaimed payouts close to automatic return as critical', () => {
    const critical = overview.attention.find((a) => a.kind === 'unclaimed_return_imminent');
    expect(critical).toMatchObject({ severity: 'critical', count: 1, value: [money('USD', 2000)] });
    expect(critical?.earliestDueAt).toBe(new Date(Date.parse(daysAgo(25)) + 30 * 86_400_000).toISOString());
    expect(overview.attention[0]?.kind).toBe('unclaimed_return_imminent');
  });

  it('summarises approvals and case states', () => {
    expect(overview.cases.active).toBe(3);
    expect(overview.cases.byState.awaiting_approval).toBe(1);
    expect(overview.cases.awaitingApprovalValue).toEqual([money('USD', 3000)]);
    expect(overview.attention.find((a) => a.kind === 'awaiting_approval')?.count).toBe(1);
  });

  it('labels exceptions that rely only on imported records', () => {
    const imported = importedItem('imp-unc', 'UNCLAIMED', daysAgo(26));
    const withImported = buildOverview(
      dataset([...items, imported], [...cases, paymentCase('c5', 'imp-unc', 'open', { basis: 'imported_record' })]),
      NOW,
    );
    expect(withImported.exceptionsByStatus.find((s) => s.status === 'UNCLAIMED')).toMatchObject({ count: 3, unconfirmedCount: 1 });
    expect(withImported.attention.find((a) => a.kind === 'unclaimed_return_imminent')?.count).toBe(2);
  });
});

describe('deriveNextAction', () => {
  it('never suggests retrying a blocked payout', () => {
    const action = deriveNextAction(paymentCase('c', 'b', 'open'), item('b', 'BLOCKED'));
    expect(action.code).toBe('compliance_review');
  });

  it('gives unclaimed payouts the expected return deadline', () => {
    const action = deriveNextAction(paymentCase('c', 'u', 'investigating'), item('u', 'UNCLAIMED', { statusUpdatedAt: daysAgo(10) }));
    expect(action.code).toBe('prompt_recipient_claim');
    expect(action.dueAt).toBe(new Date(Date.parse(daysAgo(10)) + 30 * 86_400_000).toISOString());
  });

  it('defers to the approver once a recovery is proposed', () => {
    expect(deriveNextAction(paymentCase('c', 'r', 'awaiting_approval'), item('r', 'RETURNED')).code).toBe('approver_decision');
  });

  it('asks for confirmation, never a payment decision, on possible duplicates', () => {
    const c = paymentCase('c', 'd', 'open', { basis: 'reconciliation_conflict', openingReason: 'possible_duplicate_payment' });
    expect(deriveNextAction(c, importedItem('d', 'SUCCESS')).code).toBe('confirm_possible_duplicate');
  });

  it('uses the imported status date for unclaimed deadlines when the provider has reported nothing', () => {
    const c = paymentCase('c', 'u', 'open', { basis: 'imported_record', openingReason: 'exception_status_recorded' });
    const action = deriveNextAction(c, importedItem('u', 'UNCLAIMED', daysAgo(20)));
    expect(action.dueAt).toBe(new Date(Date.parse(daysAgo(20)) + 30 * 86_400_000).toISOString());
  });
});
