/**
 * PayPal Payouts vocabulary, as published in the Payouts REST API reference
 * (batch_header.batch_status, payout item transaction_status and webhook event names).
 */

export const PAYOUT_BATCH_STATUSES = ['DENIED', 'PENDING', 'PROCESSING', 'SUCCESS', 'CANCELED'] as const;
export type PayoutBatchStatus = (typeof PAYOUT_BATCH_STATUSES)[number];

export const PAYOUT_ITEM_STATUSES = [
  'SUCCESS',
  'FAILED',
  'PENDING',
  'UNCLAIMED',
  'RETURNED',
  'ONHOLD',
  'BLOCKED',
  'REFUNDED',
  'REVERSED',
] as const;
export type PayoutItemStatus = (typeof PAYOUT_ITEM_STATUSES)[number];

export const PAYOUT_WEBHOOK_EVENT_TYPES = [
  'PAYMENT.PAYOUTSBATCH.DENIED',
  'PAYMENT.PAYOUTSBATCH.PROCESSING',
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED',
  'PAYMENT.PAYOUTS-ITEM.DENIED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
  'PAYMENT.PAYOUTS-ITEM.HELD',
  'PAYMENT.PAYOUTS-ITEM.REFUNDED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
] as const;
export type PayoutWebhookEventType = (typeof PAYOUT_WEBHOOK_EVENT_TYPES)[number];

/** PayPal returns unclaimed payouts to the sender if the recipient does not claim them within 30 days. */
export const UNCLAIMED_AUTO_RETURN_DAYS = 30;

/**
 * How a provider status relates to delivery of funds:
 * - delivered:     funds credited to the recipient.
 * - in_flight:     outcome not yet final (processing, held, or waiting for the recipient to claim).
 * - not_delivered: the attempt ended without funds reaching the recipient.
 * - reversed:      funds were delivered and later returned to the sender.
 */
export type SettlementState = 'delivered' | 'in_flight' | 'not_delivered' | 'reversed';

export interface PayoutItemStatusInfo {
  label: string;
  description: string;
  settlement: SettlementState;
}

export const PAYOUT_ITEM_STATUS_INFO: Record<PayoutItemStatus, PayoutItemStatusInfo> = {
  SUCCESS: {
    label: 'Delivered',
    description: 'The provider reports the funds were credited to the recipient.',
    settlement: 'delivered',
  },
  PENDING: {
    label: 'Pending',
    description: 'The provider has accepted the item and is still processing it.',
    settlement: 'in_flight',
  },
  ONHOLD: {
    label: 'On hold',
    description: 'The provider is holding the item, typically for review. No operator action is possible until it is released.',
    settlement: 'in_flight',
  },
  UNCLAIMED: {
    label: 'Unclaimed',
    description: `The recipient has not claimed the payout, usually because no PayPal account is linked to the identifier. Unclaimed payouts are returned after ${UNCLAIMED_AUTO_RETURN_DAYS} days.`,
    settlement: 'in_flight',
  },
  RETURNED: {
    label: 'Returned',
    description: `The payout was not claimed within ${UNCLAIMED_AUTO_RETURN_DAYS} days and the funds were returned to the sender.`,
    settlement: 'not_delivered',
  },
  FAILED: {
    label: 'Failed',
    description: 'The provider could not complete the payout. Funds were not delivered.',
    settlement: 'not_delivered',
  },
  BLOCKED: {
    label: 'Blocked',
    description: 'The provider blocked the payout. Do not retry without a compliance review.',
    settlement: 'not_delivered',
  },
  REFUNDED: {
    label: 'Refunded',
    description: 'The payout was delivered and later refunded to the sender.',
    settlement: 'reversed',
  },
  REVERSED: {
    label: 'Reversed',
    description: 'The payout was delivered and later reversed by the provider.',
    settlement: 'reversed',
  },
};

export const PAYOUT_BATCH_STATUS_INFO: Record<PayoutBatchStatus, { label: string; description: string }> = {
  PENDING: { label: 'Pending', description: 'The provider has received the batch and not yet started processing it.' },
  PROCESSING: { label: 'Processing', description: 'The provider is processing the items in this batch.' },
  SUCCESS: {
    label: 'Processed',
    description: 'The provider has finished processing the batch. Individual items may still have failed or be unclaimed.',
  },
  DENIED: { label: 'Denied', description: 'The provider rejected the whole batch. No items were paid.' },
  CANCELED: { label: 'Cancelled', description: 'The batch was cancelled before processing.' },
};
