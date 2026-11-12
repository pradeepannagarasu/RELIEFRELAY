import { z } from 'zod';
import { PAYOUT_BATCH_STATUSES, PAYOUT_ITEM_STATUSES, type PayoutBatchStatus, type PayoutItemStatus } from '@shared/domain/paypal';
import { parsePayPalAmount } from '@shared/domain/payouts';
import { PAYPAL_ID } from './client';

/** Parsers for the parts of PayPal Payouts responses ReliefRelay relies on. Unknown fields are ignored. */

const Amount = z.object({ value: z.string(), currency: z.string() }).loose();

const ItemBody = z
  .object({
    payout_item_id: z.string().regex(PAYPAL_ID),
    transaction_id: z.string().optional().nullable(),
    transaction_status: z.string().optional().nullable(),
    payout_batch_id: z.string().regex(PAYPAL_ID).optional(),
    payout_item: z
      .object({ amount: Amount.optional(), receiver: z.string().optional(), sender_item_id: z.string().optional(), recipient_type: z.string().optional() })
      .loose()
      .optional(),
    currency_conversion: z.unknown().optional(),
    errors: z.object({ name: z.string().optional() }).loose().optional().nullable(),
  })
  .loose();

const BatchBody = z
  .object({
    batch_header: z
      .object({
        payout_batch_id: z.string().regex(PAYPAL_ID),
        batch_status: z.string(),
        sender_batch_header: z.object({ sender_batch_id: z.string().optional() }).loose().optional(),
      })
      .loose(),
    items: z.array(ItemBody).optional(),
  })
  .loose();

export interface ParsedItem {
  payoutItemId: string;
  transactionId: string | null;
  /** Null when PayPal returned a status ReliefRelay does not recognise; rawStatus keeps what was received. */
  status: PayoutItemStatus | null;
  rawStatus: string | null;
  payoutBatchId: string | null;
  senderItemId: string | null;
  receiver: string | null;
  /** Parsed minor units, or null when the amount was missing or not a two-decimal value. */
  amountMinor: number | null;
  rawAmount: string | null;
  currency: string | null;
  currencyConversion: boolean;
  errorName: string | null;
}

export interface ParsedBatch {
  payoutBatchId: string;
  batchStatus: PayoutBatchStatus | null;
  rawBatchStatus: string;
  senderBatchId: string | null;
  items: ParsedItem[];
}

const toItem = (item: z.infer<typeof ItemBody>): ParsedItem => {
  const raw = item.transaction_status ?? null;
  const status = raw && (PAYOUT_ITEM_STATUSES as readonly string[]).includes(raw) ? (raw as PayoutItemStatus) : null;
  const amount = item.payout_item?.amount;
  return {
    payoutItemId: item.payout_item_id,
    transactionId: item.transaction_id && PAYPAL_ID.test(item.transaction_id) ? item.transaction_id : null,
    status,
    rawStatus: raw ? raw.slice(0, 40) : null,
    payoutBatchId: item.payout_batch_id ?? null,
    senderItemId: item.payout_item?.sender_item_id ?? null,
    receiver: item.payout_item?.receiver ?? null,
    amountMinor: amount ? parsePayPalAmount(amount.value) : null,
    rawAmount: amount ? amount.value.slice(0, 40) : null,
    currency: amount ? amount.currency.slice(0, 10) : null,
    currencyConversion: item.currency_conversion !== undefined && item.currency_conversion !== null,
    errorName: item.errors?.name ? item.errors.name.slice(0, 100) : null,
  };
};

export function parseItem(body: unknown): ParsedItem | null {
  const parsed = ItemBody.safeParse(body);
  return parsed.success ? toItem(parsed.data) : null;
}

export function parseBatch(body: unknown): ParsedBatch | null {
  const parsed = BatchBody.safeParse(body);
  if (!parsed.success) return null;
  const header = parsed.data.batch_header;
  return {
    payoutBatchId: header.payout_batch_id,
    batchStatus: (PAYOUT_BATCH_STATUSES as readonly string[]).includes(header.batch_status) ? (header.batch_status as PayoutBatchStatus) : null,
    rawBatchStatus: header.batch_status.slice(0, 40),
    senderBatchId: header.sender_batch_header?.sender_batch_id ?? null,
    items: (parsed.data.items ?? []).map(toItem),
  };
}

/** The payout batch ID in a link such as https://api-m.sandbox.paypal.com/v1/payments/payouts/ABC123. */
export function batchIdFromLinks(links: string[]): string | null {
  for (const href of links) {
    const match = /\/v1\/payments\/payouts\/([A-Za-z0-9-]{1,64})(?:[?#]|$)/.exec(href);
    if (match) return match[1]!;
  }
  return null;
}
