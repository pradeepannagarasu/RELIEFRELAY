import type { PayoutItemStatus } from './paypal';
import type { IsoDateTime, PaymentItem } from './types';

export type StatusSource = 'provider' | 'imported';

/** The status used for operational work, and where it came from. */
export interface ReportedStatus {
  status: PayoutItemStatus;
  at: IsoDateTime | null;
  errorCode: string | null;
  source: StatusSource;
}

/**
 * Provider-confirmed status always takes precedence. The imported status is used only when the provider
 * has reported nothing, and is always labelled as unconfirmed wherever it is shown.
 */
export function reportedStatus(item: PaymentItem): ReportedStatus | null {
  if (item.provider) {
    return {
      status: item.provider.status,
      at: item.provider.statusUpdatedAt,
      errorCode: item.provider.errorCode,
      source: 'provider',
    };
  }
  if (item.imported) {
    return {
      status: item.imported.status,
      at: item.imported.statusAt ?? item.imported.recordedAt,
      errorCode: item.imported.errorCode,
      source: 'imported',
    };
  }
  return null;
}

export const EXCEPTION_STATUSES: readonly PayoutItemStatus[] = [
  'FAILED',
  'UNCLAIMED',
  'RETURNED',
  'ONHOLD',
  'BLOCKED',
  'REFUNDED',
  'REVERSED',
];

export function isExceptionStatus(status: PayoutItemStatus): boolean {
  return EXCEPTION_STATUSES.includes(status);
}
