import type { CurrencyCode } from '@shared/domain/money';
import type { RecipientType } from '@shared/domain/types';
import { sha256Hex } from '../db/connection';

export interface FinancialIdentity {
  batchReference: string;
  paymentReference: string;
  recipientReference: string;
  receiverType: RecipientType;
  receiver: string;
  amountMinor: number;
  currency: CurrencyCode;
}

export function normaliseReceiver(type: RecipientType, value: string): string {
  const trimmed = value.trim();
  return type === 'EMAIL' ? trimmed.toLowerCase() : trimmed.replace(/[\s().-]/g, '');
}

/**
 * SHA-256 over everything that defines who is paid how much. A later import of the same payment reference
 * must produce the same fingerprint; anything else is a conflict and is never applied.
 */
export function paymentFingerprint(identity: FinancialIdentity): string {
  return sha256Hex(
    JSON.stringify([
      identity.batchReference,
      identity.paymentReference,
      identity.recipientReference,
      identity.receiverType,
      normaliseReceiver(identity.receiverType, identity.receiver),
      identity.amountMinor,
      identity.currency,
    ]),
  );
}

/** Display-safe form of a receiver identifier: a•••7@example.org or +447•••23. */
export function maskReceiver(type: RecipientType, value: string): string {
  const normalised = normaliseReceiver(type, value);
  if (type === 'EMAIL') {
    const at = normalised.lastIndexOf('@');
    const local = normalised.slice(0, at);
    const domain = normalised.slice(at + 1);
    return `${local.slice(0, 1)}•••${local.slice(-1)}@${domain}`;
  }
  return `${normalised.slice(0, 4)}•••${normalised.slice(-2)}`;
}
