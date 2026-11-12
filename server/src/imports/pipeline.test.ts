import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS, type ColumnMapping } from '@shared/domain/imports';
import { paymentFingerprint } from '../lib/paymentIdentity';
import { CsvFileError, parseCsvFile } from './csvFile';
import { suggestMapping, validateMapping } from './mapping';
import { findContactDetails, isFictionalPhoneNumber, isReservedEmailDomain, screenForRealContactDetails } from './privacy';
import { planImport, type ExistingBatch, type ExistingItem, type ReconciliationContext } from './reconcile';
import { validateRow } from './validateRow';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const HEADERS = ['payment_reference', 'batch_reference', 'recipient_reference', 'amount', 'currency', 'receiver_type', 'receiver', 'status', 'status_date', 'error_code'];
const bytes = (text: string) => new TextEncoder().encode(text);
const csv = (...rows: string[][]) => [HEADERS, ...rows].map((r) => r.join(',')).join('\n');
const row = (ref: string, overrides: Partial<Record<(typeof HEADERS)[number], string>> = {}) => {
  const base: Record<string, string> = {
    payment_reference: ref,
    batch_reference: 'RR-B-2026-090',
    recipient_reference: `BEN-${ref.slice(-4)}`,
    amount: '120.00',
    currency: 'USD',
    receiver_type: 'EMAIL',
    receiver: `ben-${ref.slice(-4).toLowerCase()}@example.org`,
    status: 'SUCCESS',
    status_date: '2026-11-05',
    error_code: '',
    ...overrides,
  };
  return HEADERS.map((h) => base[h] ?? '');
};

function fileError(text: string | Uint8Array): CsvFileError {
  try {
    parseCsvFile(typeof text === 'string' ? bytes(text) : text);
  } catch (error) {
    if (error instanceof CsvFileError) return error;
    throw error;
  }
  throw new Error('Expected the file to be rejected');
}

const emptyContext: ReconciliationContext = { findItem: () => undefined, findBatch: () => undefined, itemsInBatch: () => [] };

function plan(text: string, context: ReconciliationContext = emptyContext) {
  const file = parseCsvFile(bytes(text));
  const mapping = suggestMapping(file.headers);
  return planImport(
    file.rows.map((r) => ({ rowNumber: r.rowNumber, validation: validateRow(r.values, file.headers.length, mapping, NOW) })),
    context,
  );
}

describe('CSV file parsing', () => {
  it('rejects empty, binary, oversized and non-UTF-8 files', () => {
    expect(fileError('').code).toBe('empty_file');
    expect(fileError(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])).code).toBe('binary_content');
    expect(fileError(new Uint8Array([0x61, 0x2c, 0x62, 0x0a, 0xff, 0xfe, 0x2c, 0x31])).code).toBe('invalid_encoding');
    expect(fileError(new Uint8Array(IMPORT_LIMITS.maxBytes + 1).fill(0x41)).code).toBe('file_too_large');
  });

  it('reports malformed CSV instead of guessing', () => {
    expect(fileError('a,b\n"unclosed,2\n3,4').code).toBe('malformed_csv');
  });

  it('requires unique, non-blank headings and at least one data row', () => {
    expect(fileError('a,,c\n1,2,3').code).toBe('blank_header');
    expect(fileError('Amount,amount\n1,2').code).toBe('duplicate_header');
    expect(fileError(HEADERS.join(',')).code).toBe('no_data_rows');
    expect(fileError(`${HEADERS.join(',')}\n,,,\n`).code).toBe('no_data_rows');
  });

  it('enforces the row and column limits', () => {
    expect(fileError(Array.from({ length: IMPORT_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(',')).code).toBe('too_many_columns');
    const many = ['a', ...Array.from({ length: IMPORT_LIMITS.maxRows + 1 }, () => '1')].join('\n');
    expect(fileError(many).code).toBe('too_many_rows');
  });

  it('strips a byte-order mark, keeps quoted commas and numbers rows like a spreadsheet', () => {
    const file = parseCsvFile(bytes(`\uFEFF${HEADERS.join(',')}\n\n"RR-1","B,1",x\n`));
    expect(file.headers[0]).toBe('payment_reference');
    expect(file.rows.map((r) => r.rowNumber)).toEqual([2, 3]);
    expect(file.rows[1]!.values.slice(0, 2)).toEqual(['RR-1', 'B,1']);
  });

  it('hashes content so an identical file is recognised', () => {
    expect(parseCsvFile(bytes(csv(row('A-0001')))).sha256).toBe(parseCsvFile(bytes(`\uFEFF${csv(row('A-0001'))}`)).sha256);
  });
});

describe('demo privacy rules', () => {
  it('accepts only reserved test domains and fictional phone ranges', () => {
    for (const domain of ['example.org', 'personal.example.com', 'example.net', 'aid.test', 'x.example', 'nowhere.invalid']) {
      expect(isReservedEmailDomain(domain)).toBe(true);
    }
    for (const domain of ['gmail.com', 'example.co.uk', 'myexample.org', 'example.org.evil.com']) expect(isReservedEmailDomain(domain)).toBe(false);
    expect(isFictionalPhoneNumber('+44 7700 900123')).toBe(true);
    expect(isFictionalPhoneNumber('+1 (212) 555-0142')).toBe(true);
    expect(isFictionalPhoneNumber('+44 7911 123456')).toBe(false);
  });

  it('finds real contact details anywhere in the file, including unmapped columns, without false positives on dates or references', () => {
    const hits = screenForRealContactDetails(
      ['ref', 'notes', 'date'],
      [
        { rowNumber: 2, values: ['RR-B-2026-019-0001', 'call +44 7911 123456', '2026-11-03'] },
        { rowNumber: 3, values: ['RR-B-2026-019-0002', 'amina@gmail.com', '2026-11-03'] },
        { rowNumber: 4, values: ['RR-B-2026-019-0003', 'ben@example.org, +44 7700 900001', '20261103'] },
        { rowNumber: 5, values: ['07911123456', '', ''] },
      ],
    );
    expect(hits).toEqual([
      { rowNumber: 2, column: 'notes', kind: 'phone' },
      { rowNumber: 3, column: 'notes', kind: 'email' },
      { rowNumber: 5, column: 'ref', kind: 'phone' },
    ]);
    expect(findContactDetails('RR-B-2026-019-0001')).toEqual([]);
  });
});

describe('column mapping', () => {
  it('suggests mappings from common header names', () => {
    expect(suggestMapping(['Payment Reference', 'Batch', 'Beneficiary ID', 'Amount', 'Currency', 'Recipient Type', 'Receiver', 'Status'])).toEqual({
      paymentReference: 0,
      batchReference: 1,
      recipientReference: 2,
      amount: 3,
      currency: 4,
      receiverType: 5,
      receiver: 6,
      recordedStatus: 7,
    });
  });

  it('reports missing required columns and columns used twice', () => {
    const problems = validateMapping({ paymentReference: 0, batchReference: 0, amount: 9 } satisfies ColumnMapping, 4);
    expect(problems.map((p) => p.field)).toEqual(['recipientReference', 'currency', 'receiverType', 'receiver', 'batchReference', 'amount']);
  });
});

describe('row validation', () => {
  const mapping = suggestMapping(HEADERS);
  const validate = (values: string[]) => validateRow(values, HEADERS.length, mapping, NOW);
  const codes = (values: string[]) => validate(values).issues.map((i) => i.code);

  it('normalises a valid row into integer minor units', () => {
    const result = validate(row('A-0001', { amount: '1200.5', currency: 'usd', receiver: 'Ben-0001@Example.org' }));
    expect(result.normalised).toMatchObject({ amountMinor: 120050, currency: 'USD', receiver: 'ben-0001@example.org', statusAt: '2026-11-05T00:00:00.000Z' });
  });

  it.each([
    ['1,200.00', 'invalid_amount'],
    ['-5', 'invalid_amount'],
    ['10.001', 'invalid_amount'],
    ['abc', 'invalid_amount'],
    ['0.00', 'invalid_amount'],
  ])('rejects the amount %s', (amount, code) => {
    expect(codes(row('A-0001', { amount }))).toContain(code);
    expect(validate(row('A-0001', { amount })).normalised).toBeNull();
  });

  it('rejects missing values, unsupported currencies, unknown statuses and impossible dates', () => {
    expect(codes(row('A-0001', { recipient_reference: '' }))).toContain('missing_required_field');
    expect(codes(row('A-0001', { currency: 'JPY' }))).toContain('unsupported_currency');
    expect(codes(row('A-0001', { status: 'DELIVERED' }))).toContain('unknown_status');
    expect(codes(row('A-0001', { status_date: '2026-02-30' }))).toContain('invalid_status_date');
    expect(codes(row('A-0001', { status_date: '2026-12-25' }))).toContain('invalid_status_date');
    expect(codes(['A-0001', 'B'])).toContain('column_count_mismatch');
  });

  it('rejects real contact details, PayPal IDs and names in the recipient reference', () => {
    expect(codes(row('A-0001', { receiver: 'amina.yusuf@gmail.com' }))).toContain('real_contact_detail');
    expect(codes(row('A-0001', { receiver_type: 'PHONE', receiver: '+447911123456' }))).toContain('real_contact_detail');
    expect(codes(row('A-0001', { receiver_type: 'PHONE', receiver: '+44 7700 900123' }))).toEqual([]);
    expect(codes(row('A-0001', { receiver_type: 'PAYPAL_ID', receiver: 'ABCDEFGHJKLMN' }))).toContain('receiver_type_not_permitted');
    expect(codes(row('A-0001', { recipient_reference: 'Amina Yusuf' }))).toContain('invalid_recipient_reference');
  });

  it('flags spreadsheet formula characters but accepts international phone numbers', () => {
    expect(codes(row('A-0001', { error_code: '=HYPERLINK(1)' }))).toContain('formula_like_value');
    expect(codes(row('A-0001', { receiver_type: 'PHONE', receiver: '+447700900123' }))).not.toContain('formula_like_value');
  });

  it('warns about stale and contradictory statuses', () => {
    expect(codes(row('A-0001', { status: 'UNCLAIMED', status_date: '2026-09-01' }))).toContain('stale_unclaimed');
    expect(codes(row('A-0001', { status: 'PENDING', status_date: '2026-10-20' }))).toContain('stale_pending');
    expect(codes(row('A-0001', { status: 'SUCCESS', error_code: 'RECEIVER_UNCONFIRMED' }))).toContain('error_code_on_success');
  });
});

describe('reconciliation plan', () => {
  it('rejects every row that shares a payment reference within the file', () => {
    const result = plan(csv(row('A-0001'), row('A-0001', { amount: '50.00' }), row('A-0002')));
    expect(result.rows.map((r) => r.outcome)).toEqual(['rejected', 'rejected', 'new_payment']);
    expect(result.rows[0]!.issues.map((i) => i.code)).toContain('duplicate_reference_in_file');
  });

  it('imports possible duplicates and flags them for confirmation without opening a case for the first', () => {
    const result = plan(csv(row('A-0001', { recipient_reference: 'BEN-SAME' }), row('A-0002', { recipient_reference: 'BEN-SAME' })));
    expect(result.rows.map((r) => r.outcome)).toEqual(['new_payment', 'new_payment']);
    expect(result.rows.map((r) => r.findings.find((f) => f.code === 'possible_duplicate_payment')?.opensCase)).toEqual([false, true]);
  });

  it('does not treat different amounts or currencies as possible duplicates', () => {
    const result = plan(csv(row('A-0001', { recipient_reference: 'BEN-SAME' }), row('A-0002', { recipient_reference: 'BEN-SAME', amount: '60.00' })));
    expect(result.rows.flatMap((r) => r.findings)).toEqual([]);
  });

  describe('against existing records', () => {
    const values = row('A-0001');
    const identity = {
      batchReference: 'RR-B-2026-090',
      paymentReference: 'A-0001',
      recipientReference: 'BEN-0001',
      receiverType: 'EMAIL' as const,
      receiver: 'ben-0001@example.org',
      amountMinor: 12000,
      currency: 'USD' as const,
    };
    const existing: ExistingItem = {
      id: 'itm_existing',
      paymentReference: 'A-0001',
      batchId: 'bat_x',
      batchReference: 'RR-B-2026-090',
      recipientReference: 'BEN-0001',
      amountMinor: 12000,
      currency: 'USD',
      fingerprint: paymentFingerprint(identity),
      provider: null,
      observations: [{ status: 'SUCCESS', statusAt: '2026-11-05T00:00:00.000Z', errorCode: null, recordedAt: '2026-11-06T00:00:00.000Z' }],
    };
    const batch: ExistingBatch = { id: 'bat_x', reference: 'RR-B-2026-090', origin: 'csv_import', programme: 'Programme' };
    const context = (item: ExistingItem, b: ExistingBatch = batch): ReconciliationContext => ({
      findItem: (ref) => (ref === item.paymentReference ? item : undefined),
      findBatch: (ref) => (ref === b.reference ? b : undefined),
      itemsInBatch: () => [item],
    });

    it('skips an identical row as already imported', () => {
      expect(plan(csv(values), context(existing)).rows[0]).toMatchObject({ outcome: 'unchanged', matchedItemId: 'itm_existing' });
    });

    it('treats a changed status on identical financial details as a new observation', () => {
      const result = plan(csv(row('A-0001', { status: 'RETURNED', status_date: '2026-11-08' })), context(existing));
      expect(result.rows[0]).toMatchObject({ outcome: 'status_update', matchedItemId: 'itm_existing' });
      expect(result.rows[0]!.findings.map((f) => f.code).sort()).toEqual(['exception_status_recorded', 'imported_status_changed']);
    });

    it('rejects a changed amount as a conflict and never overwrites the existing payment', () => {
      const result = plan(csv(row('A-0001', { amount: '999.00' })), context(existing));
      expect(result.rows[0]).toMatchObject({ outcome: 'rejected', matchedItemId: 'itm_existing' });
      expect(result.rows[0]!.findings[0]).toMatchObject({ code: 'reference_conflict', expected: { 'amount (minor units)': 12000 }, actual: { 'amount (minor units)': 99900 } });
    });

    it('flags a recorded status that contradicts the provider', () => {
      const withProvider = { ...existing, observations: [], provider: { status: 'UNCLAIMED' as const, providerItemId: 'SIM-PI-1', providerTransactionId: null } };
      const result = plan(csv(values), context(withProvider));
      expect(result.rows[0]!.outcome).toBe('status_update');
      expect(result.rows[0]!.findings.map((f) => f.code)).toContain('provider_status_conflict');
    });

    it('refuses to add new payments to a batch that was submitted to the provider', () => {
      const submitted = { ...batch, origin: 'provider_submission' as const };
      const result = plan(csv(row('A-0009')), context(existing, submitted));
      expect(result.rows[0]!.issues.map((i) => i.code)).toContain('batch_closed_to_import');
    });

    it('flags a new payment that duplicates an existing one in the same batch', () => {
      const result = plan(csv(row('A-0002', { recipient_reference: 'BEN-0001' })), context(existing));
      expect(result.rows[0]!.findings[0]).toMatchObject({ code: 'possible_duplicate_payment', opensCase: true, relatedItemIds: ['itm_existing'] });
    });
  });

  it('produces the same digest for the same inputs and a different one when outcomes change', () => {
    const text = csv(row('A-0001'), row('A-0002'));
    expect(plan(text).digest).toBe(plan(text).digest);
    expect(plan(csv(row('A-0001'), row('A-0002', { amount: 'x' }))).digest).not.toBe(plan(text).digest);
  });
});
