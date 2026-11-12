import type { PayoutItemStatus } from './paypal';

/**
 * PayPal Sandbox payment actions. Every action is proposed by one person, approved by a different person and
 * validated on the server before anything is sent. ReliefRelay never sends a payment on its own initiative.
 */

/** Currencies accepted for Sandbox payment actions. All use two decimal places. */
export const PAYOUT_CURRENCIES = ['GBP', 'USD', 'EUR'] as const;
export type PayoutCurrency = (typeof PAYOUT_CURRENCIES)[number];

export function isPayoutCurrency(value: unknown): value is PayoutCurrency {
  return typeof value === 'string' && (PAYOUT_CURRENCIES as readonly string[]).includes(value);
}

/** Approved limits. Amounts are integer minor units. */
export const PAYOUT_LIMITS = {
  maxPerPayoutMinor: 50_000,
  maxPayoutsPerDay: 20,
  maxValuePerCurrencyPerDayMinor: 200_000,
  proposalExpiryHours: 72,
  maxRecoveryAttempts: 3,
  /** A status check used to justify an action must be at most this old. */
  freshStatusCheckMinutes: 15,
  /** No automatic or manual replay of a submission after this many days from approval. */
  replayDeadlineDays: 25,
  /** "Record as not created" is only allowed once PayPal's 30-day duplicate protection has passed. */
  recordNotCreatedAfterDays: 31,
  maxSubmissionAttempts: 30,
  cancellationWindowHours: 24,
  maxCancellationSends: 3,
} as const;

/** PayPal's sender_item_id limit. */
export const SENDER_ITEM_ID_MAX_LENGTH = 63;

/** Minor units as the decimal string PayPal expects ("120.00"), using integer arithmetic only. */
export function toPayPalAmount(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new RangeError(`A payout amount must be a positive integer number of minor units, received ${minor}`);
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

const PAYPAL_AMOUNT = /^(\d{1,9})\.(\d{2})$/;

/** Parses an amount returned by PayPal. Anything other than exactly two decimal places is rejected. */
export function parsePayPalAmount(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = PAYPAL_AMOUNT.exec(value);
  if (!match) return null;
  return Number(match[1]) * 100 + Number(match[2]);
}

export function recoverySenderItemId(originalReference: string, attemptNumber: number): string {
  return `${originalReference}-R${attemptNumber}`;
}

/* ---------- Proposals ---------- */

export const PROPOSAL_ACTIONS = ['reissue', 'cancel_unclaimed'] as const;
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

export const PROPOSAL_STATUSES = ['pending_approval', 'approved', 'rejected', 'withdrawn', 'expired', 'superseded'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_REASON_CODES = [
  'returned_unclaimed',
  'failed_at_provider',
  'previous_recovery_not_delivered',
  'recipient_cannot_claim',
  'programme_team_request',
] as const;
export type ProposalReasonCode = (typeof PROPOSAL_REASON_CODES)[number];

export const PROPOSAL_REASON_INFO: Record<ProposalReasonCode, { label: string; actions: readonly ProposalAction[] }> = {
  returned_unclaimed: { label: 'The payment was returned unclaimed', actions: ['reissue'] },
  failed_at_provider: { label: 'The provider reported the payment as failed', actions: ['reissue'] },
  previous_recovery_not_delivered: { label: 'An earlier recovery payment was not delivered', actions: ['reissue'] },
  recipient_cannot_claim: { label: 'The recipient cannot claim the payout as sent', actions: ['cancel_unclaimed'] },
  programme_team_request: { label: 'The programme team asked for the payout to be stopped', actions: ['cancel_unclaimed'] },
};

export const PROPOSAL_ACTION_INFO: Record<ProposalAction, { label: string; description: string }> = {
  reissue: {
    label: 'Reissue to the original receiver',
    description: 'Send one new PayPal Sandbox payout for the same amount, to the same receiver as the original payment.',
  },
  cancel_unclaimed: {
    label: 'Cancel the unclaimed PayPal Sandbox payout',
    description: 'Ask PayPal Sandbox to cancel an unclaimed recovery payout so the test funds return to the sender.',
  },
};

export const PROPOSAL_STATUS_INFO: Record<ProposalStatus, { label: string; description: string }> = {
  pending_approval: { label: 'Awaiting approval', description: 'Needs a decision from an approver who did not propose it.' },
  approved: { label: 'Approved', description: 'Approved and submitted to PayPal Sandbox by the approver.' },
  rejected: { label: 'Rejected', description: 'An approver rejected the proposal. Nothing was sent.' },
  withdrawn: { label: 'Withdrawn', description: 'Withdrawn before a decision. Nothing was sent.' },
  expired: { label: 'Expired', description: `No decision within ${PAYOUT_LIMITS.proposalExpiryHours} hours. Nothing was sent.` },
  superseded: { label: 'Superseded', description: 'The provider status changed before a decision, so the proposal no longer applied. Nothing was sent.' },
};

/** The exact text an approver types to confirm. */
export function confirmationPhrase(action: ProposalAction, reference: string, amountMinor: number, currency: string): string {
  return action === 'reissue' ? `${reference} ${toPayPalAmount(amountMinor)} ${currency}` : `CANCEL ${reference}`;
}

/* ---------- Submissions and cancellations ---------- */

export const SUBMISSION_STATES = [
  'prepared',
  'sending',
  'accepted',
  'rejected',
  'not_processed',
  'outcome_unknown',
  'blocked_by_policy',
  'needs_manual_reconciliation',
  'reconciled_not_created',
] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

export const SUBMISSION_STATE_INFO: Record<SubmissionState, { label: string; description: string }> = {
  prepared: { label: 'Prepared', description: 'Approved and recorded. Not sent yet.' },
  sending: { label: 'Sending', description: 'The request is being sent to PayPal Sandbox.' },
  accepted: { label: 'Accepted by PayPal Sandbox', description: 'PayPal Sandbox accepted the payout batch. Item status is tracked separately.' },
  rejected: { label: 'Rejected by PayPal Sandbox', description: 'PayPal Sandbox definitively refused the request. No payout was created.' },
  not_processed: { label: 'Not processed', description: 'PayPal Sandbox did not process the request (for example a rate limit). An approver may retry with the same keys.' },
  outcome_unknown: {
    label: 'Outcome unknown',
    description: 'No clear answer was received. ReliefRelay replays the identical request on a fixed schedule; PayPal returns the original payout instead of creating a second one.',
  },
  blocked_by_policy: { label: 'Not sent', description: 'A server-side check failed immediately before sending. Nothing was sent.' },
  needs_manual_reconciliation: {
    label: 'Manual reconciliation required',
    description: 'The outcome is still unknown after the replay limit. All payment actions on this payment are blocked until an administrator reconciles it.',
  },
  reconciled_not_created: { label: 'Reconciled: not created', description: 'An administrator recorded that PayPal Sandbox never created this payout.' },
};

export const CANCELLATION_STATES = [
  'prepared',
  'prechecking',
  'sending',
  'succeeded',
  'already_cancelled',
  'not_applicable',
  'not_processed',
  'outcome_unknown',
  'needs_manual_reconciliation',
] as const;
export type CancellationState = (typeof CANCELLATION_STATES)[number];

export const CANCELLATION_STATE_INFO: Record<CancellationState, { label: string; description: string }> = {
  prepared: { label: 'Prepared', description: 'Approved. The current status is checked before anything is sent.' },
  prechecking: { label: 'Checking status', description: 'Fetching the current item status from PayPal Sandbox before sending.' },
  sending: { label: 'Sending', description: 'The cancellation request is being sent to PayPal Sandbox.' },
  succeeded: { label: 'Cancelled', description: 'PayPal Sandbox confirmed the item as RETURNED.' },
  already_cancelled: { label: 'Already cancelled', description: 'PayPal Sandbox reported the item was already cancelled and shows it as RETURNED.' },
  not_applicable: {
    label: 'Not applied',
    description: 'No cancellation took effect: the item was no longer unclaimed, or an administrator closed the cancellation after a status re-check.',
  },
  not_processed: { label: 'Not processed', description: 'PayPal Sandbox did not process the request. An approver may retry within the approval window.' },
  outcome_unknown: { label: 'Outcome unknown', description: 'No clear answer was received. The item status is fetched before anything else happens.' },
  needs_manual_reconciliation: {
    label: 'Manual reconciliation required',
    description: 'The outcome could not be confirmed automatically. Payment actions on this payment are blocked until an administrator re-checks it.',
  },
};

/** Item statuses that justify a reissue (decision D3). */
export const REISSUE_ELIGIBLE_STATUSES: readonly PayoutItemStatus[] = ['FAILED', 'RETURNED'];

export const STATUS_CHECK_SOURCES = ['post_submit', 'poll', 'webhook', 'manual', 'precheck', 'confirm', 'reconcile'] as const;
export type StatusCheckSource = (typeof STATUS_CHECK_SOURCES)[number];

export const DISCREPANCY_CODES = [
  'amount_mismatch',
  'currency_mismatch',
  'currency_conversion',
  'malformed_amount',
  'unknown_status',
  'sender_batch_mismatch',
  'sender_item_mismatch',
  'request_hash_mismatch',
  'unexpected_batch_items',
] as const;
export type DiscrepancyCode = (typeof DISCREPANCY_CODES)[number];

export const DISCREPANCY_INFO: Record<DiscrepancyCode, string> = {
  amount_mismatch: 'PayPal Sandbox reported a different amount from the one sent.',
  currency_mismatch: 'PayPal Sandbox reported a different currency from the one sent.',
  currency_conversion: 'PayPal Sandbox applied a currency conversion, which ReliefRelay never requests.',
  malformed_amount: 'PayPal Sandbox returned an amount that is not a two-decimal value.',
  unknown_status: 'PayPal Sandbox returned a status ReliefRelay does not recognise.',
  sender_batch_mismatch: 'A PayPal batch did not carry the sender batch ID ReliefRelay sent.',
  sender_item_mismatch: 'A PayPal item did not carry the sender item ID ReliefRelay sent.',
  request_hash_mismatch: 'The rebuilt request no longer matched the approved request, so nothing was sent.',
  unexpected_batch_items: 'A PayPal batch contained items ReliefRelay did not send.',
};

export const SANDBOX_NOTICE = 'PayPal Sandbox: test money only. Sandbox results do not show real-world delivery.';

/** Appended to every genuine PayPal Sandbox result recorded in the timeline. */
export const SANDBOX_RESULT_SUFFIX = 'PayPal Sandbox test money only; this does not show real-world delivery.';

/**
 * Where PayPal requests go. Derived from PAYPAL_API_BASE_URL: the real PayPal Sandbox API, or a local stub on a
 * loopback address (allowed in development and tests only). A database is bound to one target and never mixes them.
 */
export const PAYPAL_TARGETS = ['paypal_sandbox', 'local_stub'] as const;
export type PayPalTarget = (typeof PAYPAL_TARGETS)[number];

export const PAYPAL_TARGET_INFO: Record<PayPalTarget, { label: string; notice: string; description: string }> = {
  paypal_sandbox: {
    label: 'PayPal Sandbox',
    notice: SANDBOX_NOTICE,
    description: 'Requests go to the PayPal Sandbox API. Test money only; Sandbox results do not show real-world delivery.',
  },
  local_stub: {
    label: 'Local PayPal stub',
    notice: 'Local PayPal stub: every PayPal response here is generated by the ReliefRelay server itself for testing. Nothing is sent to PayPal and no PayPal transaction exists.',
    description: 'Requests go to a local stub that imitates the PayPal API for testing. Nothing reaches PayPal, not even PayPal Sandbox.',
  },
};

const STUB_RESULT_SUFFIX = 'Local stub test response: nothing was sent to PayPal and no PayPal transaction exists.';
/** Words that make "PayPal Sandbox" an adjective ("PayPal Sandbox payout"), which takes no article. */
const ADJECTIVAL_FOLLOWER = /^\s(?:payouts?|batch|items?|recovery|record|status|mode|credentials|test|data|requests?|webhooks?|accounts?)\b/i;

/**
 * Rewords "PayPal Sandbox" text for the target that produced it, so a response from the local stub can never read
 * as a PayPal Sandbox result. Text for the real PayPal Sandbox is returned unchanged.
 */
export function forPayPalTarget(text: string, target: PayPalTarget | null | undefined): string {
  if (target !== 'local_stub') return text;
  return text
    .replaceAll(SANDBOX_NOTICE, PAYPAL_TARGET_INFO.local_stub.notice)
    .replaceAll(SANDBOX_RESULT_SUFFIX, STUB_RESULT_SUFFIX)
    .replace(/(\b(?:[Tt]he|[Aa]n?) )?PayPal Sandbox\b/g, (match: string, article: string | undefined, offset: number, whole: string) => {
      if (article) return `${article}local PayPal stub`;
      const sentenceStart = /(?:^|[.!?:]\s+)$/.test(whole.slice(0, offset));
      const adjectival = ADJECTIVAL_FOLLOWER.test(whole.slice(offset + match.length)) || whole.trim() === match;
      if (adjectival) return sentenceStart ? 'Local PayPal stub' : 'local PayPal stub';
      return sentenceStart ? 'The local PayPal stub' : 'the local PayPal stub';
    });
}

/** Applies forPayPalTarget to every string in a JSON-shaped value (an API response body). */
export function forPayPalTargetDeep<T>(value: T, target: PayPalTarget | null | undefined): T {
  if (target !== 'local_stub') return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return forPayPalTarget(v, target);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
