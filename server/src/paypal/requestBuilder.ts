import { toPayPalAmount, type PayoutCurrency } from '@shared/domain/payouts';
import { sha256Hex } from '../db/connection';

export interface PayoutRequestInput {
  senderBatchId: string;
  senderItemId: string;
  receiver: string;
  amountMinor: number;
  currency: PayoutCurrency;
}

export interface BuiltPayoutRequest {
  /** The exact JSON text sent to PayPal. Built the same way every time from immutable records. */
  json: string;
  sha256: string;
}

/**
 * Builds the create-payout request for a single-item batch. Field order and wording are fixed so that the same
 * approved submission always produces byte-identical JSON, which is compared against the hash stored at approval
 * before every send.
 */
export function buildPayoutRequest(input: PayoutRequestInput): BuiltPayoutRequest {
  const body = {
    sender_batch_header: {
      sender_batch_id: input.senderBatchId,
      email_subject: 'ReliefRelay PayPal Sandbox test payout',
      email_message: 'Synthetic PayPal Sandbox test. No real money is involved.',
    },
    items: [
      {
        recipient_type: 'EMAIL',
        amount: { value: toPayPalAmount(input.amountMinor), currency: input.currency },
        receiver: input.receiver,
        sender_item_id: input.senderItemId,
        note: 'ReliefRelay Sandbox recovery test. Synthetic data only.',
      },
    ],
  };
  const json = JSON.stringify(body);
  return { json, sha256: sha256Hex(json) };
}
