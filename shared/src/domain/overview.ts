import { expectedAutoReturnAt, isCaseActive, wholeDaysUntil } from './cases';
import { sumMoney, type MoneyTotals } from './money';
import { PAYOUT_ITEM_STATUSES, PAYOUT_ITEM_STATUS_INFO, type PayoutBatchStatus, type PayoutItemStatus } from './paypal';
import { reportedStatus } from './status';
import type {
  BatchKind,
  BatchOrigin,
  CaseState,
  IsoDateTime,
  Organisation,
  PaymentCase,
  PaymentDataset,
  PaymentEvent,
  PaymentItem,
  ProviderMode,
} from './types';
import { CASE_STATES } from './types';

export const PAYMENT_OUTCOMES = [
  'delivered',
  'recovered',
  'in_progress',
  'requires_action',
  'unconfirmed',
  'closed_undelivered',
] as const;
export type PaymentOutcome = (typeof PAYMENT_OUTCOMES)[number];

export const PAYMENT_OUTCOME_INFO: Record<PaymentOutcome, { label: string; description: string }> = {
  delivered: { label: 'Delivered', description: 'The provider confirmed the original payment was delivered.' },
  recovered: {
    label: 'Recovered',
    description: 'The original payment was not delivered; an approved recovery payment was confirmed delivered.',
  },
  in_progress: {
    label: 'In progress',
    description: 'The provider is still processing the payment or an approved recovery payment.',
  },
  requires_action: {
    label: 'Requires action',
    description: 'Not delivered. An open case needs investigation, a decision or follow-up.',
  },
  unconfirmed: {
    label: 'Unconfirmed',
    description: 'Imported records with no provider record yet. Never counted as delivered until the provider confirms it.',
  },
  closed_undelivered: {
    label: 'Closed undelivered',
    description: 'Closed by an operator without a further payment.',
  },
};

/** Unclaimed payouts returning to the sender within this many days are flagged as urgent. */
export const UNCLAIMED_URGENCY_DAYS = 7;

/**
 * Classifies an original (non-recovery) payment using provider statuses as the source of truth.
 * A case marked resolved does not count as recovered unless a recovery payment actually reached SUCCESS,
 * and an imported record never counts as delivered on its own.
 */
export function classifyPayment(
  item: PaymentItem,
  paymentCase: PaymentCase | undefined,
  recoveryAttempts: readonly PaymentItem[],
): PaymentOutcome {
  if (recoveryAttempts.some((attempt) => attempt.provider?.status === 'SUCCESS')) return 'recovered';
  if (item.provider && PAYOUT_ITEM_STATUS_INFO[item.provider.status].settlement === 'delivered') return 'delivered';
  if (paymentCase?.state === 'closed') return 'closed_undelivered';
  if (
    recoveryAttempts.some((attempt) => attempt.provider && PAYOUT_ITEM_STATUS_INFO[attempt.provider.status].settlement === 'in_flight')
  ) {
    return 'in_progress';
  }
  const activeCase = paymentCase && isCaseActive(paymentCase.state) ? paymentCase : undefined;
  if (!item.provider) return activeCase ? 'requires_action' : 'unconfirmed';
  if (item.provider.status === 'PENDING' && !paymentCase) return 'in_progress';
  return 'requires_action';
}

export interface OutcomeTotal {
  outcome: PaymentOutcome;
  count: number;
  value: MoneyTotals;
}

export interface StatusTotal {
  status: PayoutItemStatus;
  count: number;
  value: MoneyTotals;
  /** How many of these rely on an imported record because the provider has reported nothing. */
  unconfirmedCount: number;
}

export type AttentionKind =
  | 'unclaimed_return_imminent'
  | 'awaiting_approval'
  | 'blocked_compliance'
  | 'provider_hold'
  | 'uninvestigated';

export type AttentionSeverity = 'critical' | 'warning' | 'info';

export interface AttentionItem {
  kind: AttentionKind;
  severity: AttentionSeverity;
  count: number;
  value: MoneyTotals;
  earliestDueAt: IsoDateTime | null;
  href: string;
}

export interface BatchSummary {
  id: string;
  reference: string;
  programme: string;
  kind: BatchKind;
  origin: BatchOrigin;
  status: PayoutBatchStatus | null;
  providerMode: ProviderMode | null;
  importedAt: IsoDateTime;
  submittedAt: IsoDateTime | null;
  itemCount: number;
  totalValue: MoneyTotals;
  outcomes: Record<PaymentOutcome, number>;
}

export interface OverviewEvent extends PaymentEvent {
  batchReference: string;
  paymentReference: string | null;
  caseReference: string | null;
  actorName: string | null;
}

export interface Overview {
  asOf: IsoDateTime;
  organisation: Organisation;
  payments: { count: number; value: MoneyTotals };
  outcomes: OutcomeTotal[];
  outstanding: { count: number; value: MoneyTotals };
  cases: { active: number; byState: Record<CaseState, number>; awaitingApprovalValue: MoneyTotals };
  exceptionsByStatus: StatusTotal[];
  attention: AttentionItem[];
  batches: BatchSummary[];
  recentEvents: OverviewEvent[];
}

const SEVERITY_ORDER: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };

function emptyOutcomeCounts(): Record<PaymentOutcome, number> {
  return { delivered: 0, recovered: 0, in_progress: 0, requires_action: 0, unconfirmed: 0, closed_undelivered: 0 };
}

function earliest(dates: IsoDateTime[]): IsoDateTime | null {
  if (dates.length === 0) return null;
  return dates.reduce((min, d) => (Date.parse(d) < Date.parse(min) ? d : min));
}

export function buildOverview(dataset: PaymentDataset, now: Date, recentEventLimit = 8): Overview {
  const casesByItem = new Map<string, PaymentCase>();
  for (const c of dataset.cases) casesByItem.set(c.paymentItemId, c);

  const recoveriesByOriginal = new Map<string, PaymentItem[]>();
  for (const item of dataset.items) {
    if (!item.recoveryOfItemId) continue;
    const list = recoveriesByOriginal.get(item.recoveryOfItemId) ?? [];
    list.push(item);
    recoveriesByOriginal.set(item.recoveryOfItemId, list);
  }

  const originals = dataset.items.filter((item) => item.recoveryOfItemId === null);
  const outcomeByItem = new Map<string, PaymentOutcome>();
  for (const item of originals) {
    outcomeByItem.set(item.id, classifyPayment(item, casesByItem.get(item.id), recoveriesByOriginal.get(item.id) ?? []));
  }

  const outcomes: OutcomeTotal[] = PAYMENT_OUTCOMES.map((outcome) => {
    const matching = originals.filter((item) => outcomeByItem.get(item.id) === outcome);
    return { outcome, count: matching.length, value: sumMoney(matching.map((i) => i.amount)) };
  });

  const outstandingItems = originals.filter((item) => {
    const outcome = outcomeByItem.get(item.id);
    return outcome === 'in_progress' || outcome === 'requires_action';
  });

  const requiringAction = originals.filter((item) => outcomeByItem.get(item.id) === 'requires_action');
  const exceptionsByStatus: StatusTotal[] = PAYOUT_ITEM_STATUSES.flatMap((status) => {
    const matching = requiringAction.filter((item) => reportedStatus(item)?.status === status);
    if (matching.length === 0) return [];
    return [
      {
        status,
        count: matching.length,
        value: sumMoney(matching.map((i) => i.amount)),
        unconfirmedCount: matching.filter((i) => !i.provider).length,
      },
    ];
  }).sort((a, b) => b.count - a.count);

  const itemsById = new Map(dataset.items.map((item) => [item.id, item]));
  const byState = Object.fromEntries(CASE_STATES.map((s) => [s, 0])) as Record<CaseState, number>;
  for (const c of dataset.cases) byState[c.state] += 1;

  const activeCases = dataset.cases.filter((c) => isCaseActive(c.state));
  const activeWithItem = activeCases.flatMap((c) => {
    const item = itemsById.get(c.paymentItemId);
    return item ? [{ c, item }] : [];
  });
  const awaitingApproval = activeWithItem.filter(({ c }) => c.state === 'awaiting_approval');

  const attention: AttentionItem[] = [];
  const pushAttention = (
    kind: AttentionKind,
    severity: AttentionSeverity,
    rows: { item: PaymentItem }[],
    href: string,
    dueDates: IsoDateTime[] = [],
  ) => {
    if (rows.length === 0) return;
    attention.push({
      kind,
      severity,
      count: rows.length,
      value: sumMoney(rows.map((r) => r.item.amount)),
      earliestDueAt: earliest(dueDates),
      href,
    });
  };

  const statusOf = (item: PaymentItem) => reportedStatus(item)?.status;
  const imminentUnclaimed = activeWithItem
    .flatMap((row) => {
      const current = reportedStatus(row.item);
      return current?.status === 'UNCLAIMED' && current.at ? [{ ...row, dueAt: expectedAutoReturnAt(current.at) }] : [];
    })
    .filter(({ dueAt }) => wholeDaysUntil(dueAt, now) <= UNCLAIMED_URGENCY_DAYS);
  pushAttention(
    'unclaimed_return_imminent',
    'critical',
    imminentUnclaimed,
    '/cases?status=UNCLAIMED',
    imminentUnclaimed.map((r) => r.dueAt),
  );
  pushAttention('awaiting_approval', 'warning', awaitingApproval, '/approvals');
  pushAttention(
    'blocked_compliance',
    'warning',
    activeWithItem.filter(({ c, item }) => statusOf(item) === 'BLOCKED' && c.state !== 'awaiting_approval'),
    '/cases?status=BLOCKED',
  );
  pushAttention(
    'provider_hold',
    'info',
    activeWithItem.filter(({ item }) => statusOf(item) === 'ONHOLD'),
    '/cases?status=ONHOLD',
  );
  pushAttention(
    'uninvestigated',
    'info',
    activeWithItem.filter(({ c }) => c.state === 'open'),
    '/cases?state=open',
  );
  attention.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const batchesById = new Map(dataset.batches.map((b) => [b.id, b]));
  const batches: BatchSummary[] = dataset.batches
    .map((batch) => {
      const items = dataset.items.filter((item) => item.batchId === batch.id);
      const counts = emptyOutcomeCounts();
      for (const item of items) {
        const outcome = item.recoveryOfItemId === null ? outcomeByItem.get(item.id) : classifyRecoveryAttempt(item);
        if (outcome) counts[outcome] += 1;
      }
      return {
        id: batch.id,
        reference: batch.reference,
        programme: batch.programme,
        kind: batch.kind,
        origin: batch.origin,
        status: batch.status,
        providerMode: batch.providerMode,
        importedAt: batch.importedAt,
        submittedAt: batch.submittedAt,
        itemCount: items.length,
        totalValue: sumMoney(items.map((i) => i.amount)),
        outcomes: counts,
      };
    })
    .sort((a, b) => Date.parse(b.importedAt) - Date.parse(a.importedAt));

  const casesById = new Map(dataset.cases.map((c) => [c.id, c]));
  const usersById = new Map(dataset.users.map((u) => [u.id, u]));
  const recentEvents: OverviewEvent[] = [...dataset.events]
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .slice(0, recentEventLimit)
    .map((event) => ({
      ...event,
      batchReference: batchesById.get(event.batchId)?.reference ?? 'Unknown batch',
      paymentReference: event.paymentItemId ? (itemsById.get(event.paymentItemId)?.senderItemId ?? null) : null,
      caseReference: event.caseId ? (casesById.get(event.caseId)?.reference ?? null) : null,
      actorName: event.actorUserId ? (usersById.get(event.actorUserId)?.displayName ?? null) : null,
    }));

  return {
    asOf: now.toISOString(),
    organisation: dataset.organisation,
    payments: { count: originals.length, value: sumMoney(originals.map((i) => i.amount)) },
    outcomes,
    outstanding: { count: outstandingItems.length, value: sumMoney(outstandingItems.map((i) => i.amount)) },
    cases: {
      active: activeCases.length,
      byState,
      awaitingApprovalValue: sumMoney(awaitingApproval.map((r) => r.item.amount)),
    },
    exceptionsByStatus,
    attention,
    batches,
    recentEvents,
  };
}

/** Recovery attempts are summarised by their own provider status. */
function classifyRecoveryAttempt(item: PaymentItem): PaymentOutcome {
  if (!item.provider) return 'unconfirmed';
  switch (PAYOUT_ITEM_STATUS_INFO[item.provider.status].settlement) {
    case 'delivered':
      return 'delivered';
    case 'in_flight':
      return 'in_progress';
    case 'not_delivered':
    case 'reversed':
      return 'requires_action';
  }
}
