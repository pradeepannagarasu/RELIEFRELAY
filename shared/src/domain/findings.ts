import type { CaseBasis } from './types';

/**
 * Reconciliation findings are produced by fixed, deterministic rules and stored permanently against a payment.
 * They describe what the records show. They never judge a recipient or conclude that fraud occurred.
 */
export const FINDING_CODES = [
  'exception_status_recorded',
  'stale_unclaimed',
  'stale_pending',
  'error_code_on_success',
  'possible_duplicate_payment',
  'reference_conflict',
  'provider_status_conflict',
  'provider_reference_mismatch',
  'imported_status_changed',
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

export type FindingSeverity = 'info' | 'warning' | 'critical';

export interface FindingInfo {
  label: string;
  description: string;
  severity: FindingSeverity;
  /** The basis of the case opened for this finding, or null if it never opens a case on its own. */
  opensCase: CaseBasis | null;
}

/** Version of the rule set; stored with every finding so later rule changes stay traceable. */
export const RECONCILIATION_RULE_VERSION = 1;

/** PENDING for longer than this is unusual for PayPal Payouts and worth checking. */
export const STALE_PENDING_DAYS = 7;

export const FINDING_INFO: Record<FindingCode, FindingInfo> = {
  exception_status_recorded: {
    label: 'Undelivered status in imported record',
    description: 'The organisation’s record shows the payment was not delivered or is held. The provider has not confirmed this.',
    severity: 'warning',
    opensCase: 'imported_record',
  },
  stale_unclaimed: {
    label: 'Unclaimed for more than 30 days',
    description: 'PayPal returns unclaimed payouts after 30 days, so this record is probably out of date. Check the provider status.',
    severity: 'warning',
    opensCase: 'imported_record',
  },
  stale_pending: {
    label: 'Pending for an unusually long time',
    description: `The record has shown PENDING for more than ${STALE_PENDING_DAYS} days. Check whether the provider has an outcome.`,
    severity: 'warning',
    opensCase: 'imported_record',
  },
  error_code_on_success: {
    label: 'Error code on a delivered payment',
    description: 'The record shows SUCCESS together with an error code. One of the two values is likely wrong.',
    severity: 'warning',
    opensCase: 'reconciliation_conflict',
  },
  possible_duplicate_payment: {
    label: 'Possible duplicate payment',
    description:
      'Another payment in the same batch has the same recipient reference, amount and currency. This may be intended. Confirm with the programme team; nothing is merged, deleted or paid automatically.',
    severity: 'warning',
    opensCase: 'reconciliation_conflict',
  },
  reference_conflict: {
    label: 'Conflicting payment details',
    description:
      'An import contained this payment reference with different financial details. The existing record was kept and the imported row was rejected.',
    severity: 'critical',
    opensCase: 'reconciliation_conflict',
  },
  provider_status_conflict: {
    label: 'Imported status differs from provider',
    description: 'The organisation’s record and the provider report different statuses. The provider status is treated as authoritative.',
    severity: 'warning',
    opensCase: 'reconciliation_conflict',
  },
  provider_reference_mismatch: {
    label: 'Provider reference mismatch',
    description: 'The imported provider item or transaction ID does not match the provider record for this payment.',
    severity: 'warning',
    opensCase: 'reconciliation_conflict',
  },
  imported_status_changed: {
    label: 'Imported status changed',
    description: 'A later import recorded a different status for this payment. Earlier observations are kept.',
    severity: 'info',
    opensCase: null,
  },
};

/** A seeded or provider-reported exception opens a case without a reconciliation finding. */
export type CaseOpeningReason = FindingCode | 'provider_exception';

export function describeOpeningReason(reason: string): string {
  if (reason === 'provider_exception') return 'Provider reported an undelivered or held payment';
  return (FINDING_INFO as Record<string, FindingInfo | undefined>)[reason]?.label ?? reason;
}
