import { STALE_PENDING_DAYS } from '@shared/domain/findings';
import { IMPORT_FIELD_INFO, type ColumnMapping, type ImportField, type RowIssue, type RowIssueCode, type RowIssueSeverity } from '@shared/domain/imports';
import { parseDecimalAmount, SUPPORTED_CURRENCIES, type CurrencyCode } from '@shared/domain/money';
import { PAYOUT_ITEM_STATUSES, UNCLAIMED_AUTO_RETURN_DAYS, type PayoutItemStatus } from '@shared/domain/paypal';
import { isExceptionStatus } from '@shared/domain/status';
import type { RecipientType } from '@shared/domain/types';
import { normaliseReceiver } from '../lib/paymentIdentity';
import { findContactDetails, isFictionalPhoneNumber, isReservedEmailDomain } from './privacy';

export interface NormalisedRow {
  paymentReference: string;
  batchReference: string;
  recipientReference: string;
  amountMinor: number;
  currency: CurrencyCode;
  receiverType: RecipientType;
  /** Normalised synthetic receiver identifier. */
  receiver: string;
  programme: string | null;
  recordedStatus: PayoutItemStatus | null;
  statusAt: string | null;
  errorCode: string | null;
  providerItemId: string | null;
  providerTransactionId: string | null;
}

export interface RowValidation {
  blank: boolean;
  /** The payment reference as written, even when the row has other errors; used for duplicate detection. */
  paymentReference: string | null;
  normalised: NormalisedRow | null;
  issues: RowIssue[];
}

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RECIPIENT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/;
const PROVIDER_ID = /^[A-Za-z0-9-]{1,64}$/;
const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164 = /^\+\d{8,15}$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 86_400_000;

const MAX_LENGTH: Partial<Record<ImportField, number>> = {
  paymentReference: 64,
  batchReference: 64,
  recipientReference: 40,
  receiver: 254,
  programme: 200,
  errorCode: 64,
  providerItemId: 64,
  providerTransactionId: 64,
};

function parseStatusDate(value: string, now: Date): { iso: string } | { error: string } {
  const dateOnly = DATE_ONLY.exec(value);
  let parsed: Date;
  if (dateOnly) {
    parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return { error: `${value} is not a real calendar date.` };
  } else if (DATE_TIME.test(value)) {
    parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return { error: `${value} is not a valid date and time.` };
  } else {
    return { error: 'Use YYYY-MM-DD or an ISO 8601 date and time, e.g. 2026-11-02 or 2026-11-02T14:30:00Z.' };
  }
  if (parsed.getTime() > now.getTime() + 5 * 60 * 1000) return { error: 'The status date is in the future.' };
  return { iso: parsed.toISOString() };
}

/** Validates and normalises one CSV row against the column mapping. Pure: depends only on its arguments. */
export function validateRow(values: string[], headerCount: number, mapping: ColumnMapping, now: Date): RowValidation {
  if (values.every((cell) => cell.trim() === '')) return { blank: true, paymentReference: null, normalised: null, issues: [] };

  const issues: RowIssue[] = [];
  const add = (code: RowIssueCode, severity: RowIssueSeverity, field: ImportField | null, message: string) =>
    issues.push({ code, severity, field, message });
  const raw = (field: ImportField) => {
    const column = mapping[field];
    return column === undefined ? '' : (values[column] ?? '');
  };
  const get = (field: ImportField) => raw(field).trim();
  const label = (field: ImportField) => IMPORT_FIELD_INFO[field].label;

  if (values.length !== headerCount) {
    add('column_count_mismatch', 'error', null, `This row has ${values.length} values but the file has ${headerCount} columns.`);
  }

  for (const field of Object.keys(mapping) as ImportField[]) {
    const value = get(field);
    const max = MAX_LENGTH[field];
    if (max !== undefined && value.length > max) add('value_too_long', 'error', field, `${label(field)} is longer than ${max} characters.`);
    const first = raw(field).charAt(0);
    const phoneReceiver = field === 'receiver' && /^\+\d/.test(value);
    if (field !== 'amount' && !phoneReceiver && ['=', '+', '-', '@', '\t', '\r'].includes(first)) {
      add(
        'formula_like_value',
        'warning',
        field,
        `${label(field)} starts with “${first === '\t' ? 'tab' : first === '\r' ? 'carriage return' : first}”, which spreadsheets may run as a formula. It is stored as plain text.`,
      );
    }
  }

  const required = (field: ImportField) => {
    const value = get(field);
    if (value === '') add('missing_required_field', 'error', field, `${label(field)} is missing.`);
    return value;
  };

  const paymentReference = required('paymentReference');
  if (paymentReference && !REFERENCE.test(paymentReference)) {
    add('invalid_reference', 'error', 'paymentReference', 'Payment reference may contain only letters, digits, dots, dashes and underscores.');
  }
  const batchReference = required('batchReference');
  if (batchReference && !REFERENCE.test(batchReference)) {
    add('invalid_reference', 'error', 'batchReference', 'Batch reference may contain only letters, digits, dots, dashes and underscores.');
  }

  const recipientReference = required('recipientReference');
  if (recipientReference) {
    if (findContactDetails(recipientReference).length > 0) {
      add('personal_data_in_text', 'error', 'recipientReference', 'Recipient reference looks like contact information. Use a pseudonymous programme reference.');
    } else if (!RECIPIENT_REFERENCE.test(recipientReference)) {
      add(
        'invalid_recipient_reference',
        'error',
        'recipientReference',
        'Recipient reference must be 3 to 40 letters, digits, dots, dashes or underscores, with no spaces. Never use a name.',
      );
    }
  }

  const currencyRaw = required('currency').toUpperCase();
  const currency = (SUPPORTED_CURRENCIES as readonly string[]).includes(currencyRaw) ? (currencyRaw as CurrencyCode) : null;
  if (currencyRaw && !currency) add('unsupported_currency', 'error', 'currency', `${currencyRaw} is not supported. Use USD, EUR or GBP.`);

  const amountRaw = required('amount');
  const amount = amountRaw ? parseDecimalAmount(amountRaw, currency ?? 'USD') : null;
  if (amountRaw && !amount) {
    add(
      'invalid_amount',
      'error',
      'amount',
      `“${amountRaw}” is not a valid amount. Use digits with up to two decimal places and no thousands separators, e.g. 1200.00.`,
    );
  } else if (amount && amount.minor <= 0) {
    add('invalid_amount', 'error', 'amount', 'Amount must be greater than zero.');
  }

  const receiverTypeRaw = required('receiverType').toUpperCase();
  let receiverType: RecipientType | null = null;
  if (receiverTypeRaw === 'EMAIL' || receiverTypeRaw === 'PHONE') receiverType = receiverTypeRaw;
  else if (receiverTypeRaw === 'PAYPAL_ID') {
    add('receiver_type_not_permitted', 'error', 'receiverType', 'PAYPAL_ID receivers cannot be shown to be synthetic, so they are not accepted for the demo organisation.');
  } else if (receiverTypeRaw) add('invalid_receiver_type', 'error', 'receiverType', 'Receiver type must be EMAIL or PHONE.');

  const receiverRaw = required('receiver');
  let receiver: string | null = null;
  if (receiverRaw && receiverType === 'EMAIL') {
    const normalised = normaliseReceiver('EMAIL', receiverRaw);
    if (!EMAIL.test(normalised)) add('invalid_receiver', 'error', 'receiver', 'Receiver is not a valid email address.');
    else if (!isReservedEmailDomain(normalised.slice(normalised.lastIndexOf('@') + 1))) {
      add('real_contact_detail', 'error', 'receiver', 'Only synthetic addresses on reserved test domains such as example.org are accepted.');
    } else receiver = normalised;
  } else if (receiverRaw && receiverType === 'PHONE') {
    const normalised = normaliseReceiver('PHONE', receiverRaw);
    if (!E164.test(normalised)) add('invalid_receiver', 'error', 'receiver', 'Use international format for phone receivers, e.g. +447700900123.');
    else if (!isFictionalPhoneNumber(normalised)) {
      add('real_contact_detail', 'error', 'receiver', 'Only fictional numbers are accepted: +44 7700 900000 to 900999, or US 555-0100 to 555-0199.');
    } else receiver = normalised;
  }

  const programme = get('programme') || null;
  if (programme && findContactDetails(programme).length > 0) {
    add('personal_data_in_text', 'error', 'programme', 'Programme contains contact information. Remove it before importing.');
  }

  const statusRaw = get('recordedStatus').toUpperCase();
  const recordedStatus = statusRaw === '' ? null : (PAYOUT_ITEM_STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as PayoutItemStatus) : null;
  if (statusRaw && !recordedStatus) {
    add('unknown_status', 'error', 'recordedStatus', `“${statusRaw}” is not a PayPal payout item status. Use ${PAYOUT_ITEM_STATUSES.join(', ')}.`);
  }

  const statusDateRaw = get('statusDate');
  let statusAt: string | null = null;
  if (statusDateRaw) {
    const parsed = parseStatusDate(statusDateRaw, now);
    if ('error' in parsed) add('invalid_status_date', 'error', 'statusDate', parsed.error);
    else statusAt = parsed.iso;
  }

  const errorCode = get('errorCode') || null;
  if (errorCode && findContactDetails(errorCode).length > 0) {
    add('personal_data_in_text', 'error', 'errorCode', 'Error code contains contact information.');
  } else if (errorCode && !ERROR_CODE.test(errorCode)) {
    add('invalid_reference', 'error', 'errorCode', 'Error code may contain only letters, digits, dots, dashes and underscores.');
  }

  const providerItemId = get('providerItemId') || null;
  if (providerItemId && !PROVIDER_ID.test(providerItemId)) add('invalid_reference', 'error', 'providerItemId', 'Provider item ID may contain only letters, digits and dashes.');
  const providerTransactionId = get('providerTransactionId') || null;
  if (providerTransactionId && !PROVIDER_ID.test(providerTransactionId)) {
    add('invalid_reference', 'error', 'providerTransactionId', 'Provider transaction ID may contain only letters, digits and dashes.');
  }

  if (recordedStatus === 'SUCCESS' && errorCode) {
    add('error_code_on_success', 'warning', 'errorCode', 'The row shows SUCCESS together with an error code. A case will be opened to confirm which is correct.');
  }
  const ageDays = statusAt ? (now.getTime() - Date.parse(statusAt)) / DAY_MS : null;
  if (recordedStatus === 'UNCLAIMED' && ageDays !== null && ageDays > UNCLAIMED_AUTO_RETURN_DAYS) {
    add('stale_unclaimed', 'warning', 'statusDate', `Recorded as unclaimed more than ${UNCLAIMED_AUTO_RETURN_DAYS} days ago; PayPal would normally have returned it by now.`);
  }
  if (recordedStatus === 'PENDING' && ageDays !== null && ageDays > STALE_PENDING_DAYS) {
    add('stale_pending', 'warning', 'statusDate', `Recorded as pending for more than ${STALE_PENDING_DAYS} days.`);
  }
  if (recordedStatus && isExceptionStatus(recordedStatus)) {
    add('exception_status_recorded', 'info', 'recordedStatus', `Recorded as ${recordedStatus}. A case will be opened unless one is already active.`);
  }

  const hasErrors = issues.some((issue) => issue.severity === 'error');
  return {
    blank: false,
    paymentReference: paymentReference || null,
    issues,
    normalised:
      !hasErrors && amount && currency && receiverType && receiver && paymentReference && batchReference && recipientReference
      ? {
          paymentReference,
          batchReference,
          recipientReference,
          amountMinor: amount.minor,
          currency,
          receiverType,
          receiver,
          programme,
          recordedStatus,
          statusAt,
          errorCode,
          providerItemId,
          providerTransactionId,
        }
      : null,
  };
}
