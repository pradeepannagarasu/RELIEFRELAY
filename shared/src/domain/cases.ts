import { UNCLAIMED_AUTO_RETURN_DAYS } from './paypal';
import { reportedStatus } from './status';
import type { CaseBasis, CaseState, IsoDateTime, PaymentCase, PaymentItem } from './types';

export const CASE_STATE_INFO: Record<CaseState, { label: string; description: string; active: boolean }> = {
  open: { label: 'Open', description: 'Exception detected and not yet investigated.', active: true },
  investigating: { label: 'Investigating', description: 'An operator is reviewing the evidence.', active: true },
  awaiting_approval: {
    label: 'Awaiting approval',
    description: 'A recovery action has been proposed and needs an approver decision.',
    active: true,
  },
  recovery_submitted: {
    label: 'Recovery submitted',
    description: 'An approved recovery payment was submitted. Waiting for the provider outcome.',
    active: true,
  },
  resolved: { label: 'Resolved', description: 'The provider confirmed delivery of a recovery payment.', active: false },
  closed: { label: 'Closed', description: 'Closed by an operator without a further payment.', active: false },
};

export const CASE_BASIS_INFO: Record<CaseBasis, { label: string; description: string }> = {
  provider_confirmed: {
    label: 'Provider-confirmed',
    description: 'Opened because the payment provider reported the payment as undelivered or held.',
  },
  imported_record: {
    label: 'Imported record',
    description: 'Opened from the organisation’s imported record. The provider has not confirmed this status.',
  },
  reconciliation_conflict: {
    label: 'Reconciliation conflict',
    description: 'Opened because records disagree with each other or may describe a duplicate payment.',
  },
};

export function isCaseActive(state: CaseState): boolean {
  return CASE_STATE_INFO[state].active;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The date by which PayPal is expected to return an unclaimed payout. The provider is the source of truth. */
export function expectedAutoReturnAt(unclaimedSince: IsoDateTime): IsoDateTime {
  return new Date(Date.parse(unclaimedSince) + UNCLAIMED_AUTO_RETURN_DAYS * DAY_MS).toISOString();
}

export function wholeDaysUntil(target: IsoDateTime, now: Date): number {
  return Math.floor((Date.parse(target) - now.getTime()) / DAY_MS);
}

export const NEXT_ACTION_CODES = [
  'approver_decision',
  'monitor_recovery',
  'confirm_possible_duplicate',
  'resolve_record_conflict',
  'check_provider_status',
  'prompt_recipient_claim',
  'verify_and_propose_reissue',
  'review_failure_reason',
  'compliance_review',
  'await_provider_review',
  'review_reversal',
  'monitor_processing',
  'review_record',
  'none',
] as const;
export type NextActionCode = (typeof NEXT_ACTION_CODES)[number];

export const NEXT_ACTION_LABELS: Record<NextActionCode, string> = {
  approver_decision: 'Approver decision required',
  monitor_recovery: 'Monitor recovery payment outcome',
  confirm_possible_duplicate: 'Confirm with the programme team whether both payments are intended',
  resolve_record_conflict: 'Confirm the correct payment details with the programme team',
  check_provider_status: 'Check the provider record against the imported status',
  prompt_recipient_claim: 'Ask programme team to prompt the recipient to claim',
  verify_and_propose_reissue: 'Verify recipient details before proposing a reissue',
  review_failure_reason: 'Review the failure reason',
  compliance_review: 'Escalate for compliance review. Do not retry',
  await_provider_review: 'Await provider review',
  review_reversal: 'Review the reversal with finance',
  monitor_processing: 'Monitor provider processing',
  review_record: 'Review the payment record',
  none: 'No action required',
};

export interface NextAction {
  code: NextActionCode;
  label: string;
  /** Deadline after which the available options change, when one is known. */
  dueAt: IsoDateTime | null;
}

const action = (code: NextActionCode, dueAt: IsoDateTime | null = null): NextAction => ({
  code,
  label: NEXT_ACTION_LABELS[code],
  dueAt,
});

/**
 * Deterministic next step for a case, derived only from the case state, why it opened and the reported status.
 * It describes operational work; it never decides whether a recipient should be paid.
 */
export function deriveNextAction(paymentCase: PaymentCase, item: PaymentItem): NextAction {
  switch (paymentCase.state) {
    case 'resolved':
    case 'closed':
      return action('none');
    case 'awaiting_approval':
      return action('approver_decision');
    case 'recovery_submitted':
      return action('monitor_recovery');
    case 'open':
    case 'investigating':
      break;
  }

  switch (paymentCase.openingReason) {
    case 'possible_duplicate_payment':
      return action('confirm_possible_duplicate');
    case 'reference_conflict':
    case 'error_code_on_success':
    case 'provider_reference_mismatch':
      return action('resolve_record_conflict');
    case 'provider_status_conflict':
    case 'stale_unclaimed':
    case 'stale_pending':
      return action('check_provider_status');
  }

  const current = reportedStatus(item);
  if (!current) return action('review_record');
  switch (current.status) {
    case 'UNCLAIMED':
      return action('prompt_recipient_claim', current.at ? expectedAutoReturnAt(current.at) : null);
    case 'RETURNED':
      return action('verify_and_propose_reissue');
    case 'FAILED':
      return action('review_failure_reason');
    case 'BLOCKED':
      return action('compliance_review');
    case 'ONHOLD':
      return action('await_provider_review');
    case 'REFUNDED':
    case 'REVERSED':
      return action('review_reversal');
    case 'PENDING':
      return action('monitor_processing');
    case 'SUCCESS':
      return action('review_record');
  }
}
