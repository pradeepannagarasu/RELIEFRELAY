export const IMPORT_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxRows: 5000,
  maxColumns: 50,
  maxCellLength: 500,
} as const;

export const IMPORT_FIELDS = [
  'paymentReference',
  'batchReference',
  'recipientReference',
  'amount',
  'currency',
  'receiverType',
  'receiver',
  'programme',
  'recordedStatus',
  'statusDate',
  'errorCode',
  'providerItemId',
  'providerTransactionId',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export interface ImportFieldInfo {
  label: string;
  required: boolean;
  description: string;
  example: string;
  /** Normalised header names suggested automatically for this field. */
  aliases: string[];
}

export const IMPORT_FIELD_INFO: Record<ImportField, ImportFieldInfo> = {
  paymentReference: {
    label: 'Payment reference',
    required: true,
    description: 'Unique reference for each intended payment (PayPal sender_item_id).',
    example: 'RR-B-2026-019-0001',
    aliases: ['paymentreference', 'paymentref', 'senderitemid', 'reference', 'itemreference', 'paymentid'],
  },
  batchReference: {
    label: 'Batch reference',
    required: true,
    description: 'The disbursement batch this payment belongs to.',
    example: 'RR-B-2026-019',
    aliases: ['batchreference', 'batchref', 'batch', 'senderbatchid', 'batchid'],
  },
  recipientReference: {
    label: 'Recipient reference',
    required: true,
    description: 'Pseudonymous programme reference. Letters, digits, dots, dashes and underscores only; never a name.',
    example: 'BEN-7KQ2PX',
    aliases: ['recipientreference', 'recipientref', 'beneficiaryreference', 'beneficiaryref', 'beneficiaryid', 'recipientid'],
  },
  amount: {
    label: 'Amount',
    required: true,
    description: 'Decimal amount with up to two decimal places and no thousands separators.',
    example: '120.00',
    aliases: ['amount', 'value', 'amountvalue', 'paymentamount'],
  },
  currency: {
    label: 'Currency',
    required: true,
    description: 'USD, EUR or GBP.',
    example: 'USD',
    aliases: ['currency', 'currencycode', 'ccy'],
  },
  receiverType: {
    label: 'Receiver type',
    required: true,
    description: 'EMAIL or PHONE (PayPal recipient_type).',
    example: 'EMAIL',
    aliases: ['receivertype', 'recipienttype', 'recipient_type', 'type'],
  },
  receiver: {
    label: 'Receiver',
    required: true,
    description: 'Synthetic test identifier only: an address on a reserved test domain or a fictional phone number.',
    example: 'ben-7kq2px@example.org',
    aliases: ['receiver', 'receiverid', 'recipient', 'receiveridentifier', 'payee'],
  },
  programme: {
    label: 'Programme',
    required: false,
    description: 'Programme name for the batch.',
    example: 'Shelter repair grants, pilot',
    aliases: ['programme', 'program', 'programmename', 'programname', 'project'],
  },
  recordedStatus: {
    label: 'Recorded status',
    required: false,
    description: 'Status in your records, using PayPal item statuses such as SUCCESS, UNCLAIMED or FAILED.',
    example: 'SUCCESS',
    aliases: ['recordedstatus', 'status', 'transactionstatus', 'itemstatus', 'paymentstatus'],
  },
  statusDate: {
    label: 'Status date',
    required: false,
    description: 'Date of the recorded status, as YYYY-MM-DD or an ISO date-time.',
    example: '2026-11-02',
    aliases: ['statusdate', 'statusupdatedat', 'statustime', 'updatedat', 'lastupdated', 'date'],
  },
  errorCode: {
    label: 'Error code',
    required: false,
    description: 'Provider error code recorded against the payment, if any.',
    example: 'RECEIVER_ACCOUNT_LOCKED',
    aliases: ['errorcode', 'error', 'errorname', 'failurereason'],
  },
  providerItemId: {
    label: 'Provider item ID',
    required: false,
    description: 'PayPal payout_item_id, if your records hold it.',
    example: '',
    aliases: ['provideritemid', 'payoutitemid', 'paypalitemid'],
  },
  providerTransactionId: {
    label: 'Provider transaction ID',
    required: false,
    description: 'PayPal transaction_id, if your records hold it.',
    example: '',
    aliases: ['providertransactionid', 'transactionid', 'paypaltransactionid'],
  },
};

export const REQUIRED_IMPORT_FIELDS = IMPORT_FIELDS.filter((field) => IMPORT_FIELD_INFO[field].required);

/** Field to zero-based column index. Unmapped optional fields are absent. */
export type ColumnMapping = Partial<Record<ImportField, number>>;

export const IMPORT_STATUSES = ['draft', 'validated', 'committed', 'discarded'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/**
 * new_payment:   a payment reference not seen before; will be created.
 * status_update: a known payment with identical financial details and a new status observation.
 * unchanged:     a known payment with identical details and status; nothing will be written.
 * rejected:      the row will not be imported.
 * blank:         an empty line; ignored.
 */
export const ROW_OUTCOMES = ['new_payment', 'status_update', 'unchanged', 'rejected', 'blank'] as const;
export type RowOutcome = (typeof ROW_OUTCOMES)[number];

export const ROW_ISSUE_CODES = [
  'column_count_mismatch',
  'missing_required_field',
  'value_too_long',
  'invalid_reference',
  'invalid_recipient_reference',
  'invalid_amount',
  'unsupported_currency',
  'invalid_receiver_type',
  'receiver_type_not_permitted',
  'invalid_receiver',
  'real_contact_detail',
  'personal_data_in_text',
  'unknown_status',
  'invalid_status_date',
  'duplicate_reference_in_file',
  'reference_conflict',
  'batch_closed_to_import',
  'formula_like_value',
  'inconsistent_programme',
  'possible_duplicate_payment',
  'error_code_on_success',
  'stale_unclaimed',
  'stale_pending',
  'exception_status_recorded',
  'provider_status_conflict',
  'provider_reference_mismatch',
  'older_than_current_status',
] as const;
export type RowIssueCode = (typeof ROW_ISSUE_CODES)[number];

export type RowIssueSeverity = 'error' | 'warning' | 'info';

export interface RowIssue {
  code: RowIssueCode;
  severity: RowIssueSeverity;
  field: ImportField | null;
  message: string;
}

export const ROW_ISSUE_LABELS: Record<RowIssueCode, string> = {
  column_count_mismatch: 'Wrong number of columns',
  missing_required_field: 'Missing required value',
  value_too_long: 'Value too long',
  invalid_reference: 'Invalid reference',
  invalid_recipient_reference: 'Invalid recipient reference',
  invalid_amount: 'Invalid amount',
  unsupported_currency: 'Unsupported currency',
  invalid_receiver_type: 'Invalid receiver type',
  receiver_type_not_permitted: 'Receiver type not permitted',
  invalid_receiver: 'Invalid receiver',
  real_contact_detail: 'Real contact detail',
  personal_data_in_text: 'Personal data in text field',
  unknown_status: 'Unknown status',
  invalid_status_date: 'Invalid status date',
  duplicate_reference_in_file: 'Duplicate reference in file',
  reference_conflict: 'Conflicts with existing payment',
  batch_closed_to_import: 'Batch closed to import',
  formula_like_value: 'Spreadsheet formula characters',
  inconsistent_programme: 'Inconsistent programme',
  possible_duplicate_payment: 'Possible duplicate payment',
  error_code_on_success: 'Error code on delivered payment',
  stale_unclaimed: 'Unclaimed over 30 days',
  stale_pending: 'Pending unusually long',
  exception_status_recorded: 'Undelivered status recorded',
  provider_status_conflict: 'Differs from provider status',
  provider_reference_mismatch: 'Provider reference mismatch',
  older_than_current_status: 'Older than current status',
};

export const ROW_OUTCOME_INFO: Record<RowOutcome, { label: string; description: string }> = {
  new_payment: { label: 'New payment', description: 'Will be recorded as a new payment.' },
  status_update: {
    label: 'Status observation',
    description: 'Known payment with identical details. The new status is added to its history; nothing is overwritten.',
  },
  unchanged: { label: 'Already imported', description: 'Identical to what is already recorded. Nothing will be written.' },
  rejected: { label: 'Rejected', description: 'Will not be imported. See the issues listed.' },
  blank: { label: 'Blank row', description: 'Empty line, ignored.' },
};
