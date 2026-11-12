import type { Db } from '../db/connection';

const HEADERS = [
  'payment_reference',
  'batch_reference',
  'programme',
  'recipient_reference',
  'amount',
  'currency',
  'receiver_type',
  'receiver',
  'recorded_status',
  'status_date',
  'error_code',
];

type Cells = [string, string, string, string, string, string, string, string, string, string, string];

const DAY_MS = 86_400_000;
const SAMPLE_BATCH = 'RR-B-2026-019';
const SAMPLE_PROGRAMME = 'Shelter repair grants, pilot';

function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(rows: Cells[]): string {
  return [HEADERS, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

const decimal = (minor: number) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
const dateOnly = (date: Date) => date.toISOString().slice(0, 10);

/** Column headers plus two synthetic example rows. */
export function buildTemplateCsv(): string {
  return toCsv([
    ['RR-B-2026-020-0001', 'RR-B-2026-020', 'Example programme', 'BEN-EXAMPLE1', '120.00', 'USD', 'EMAIL', 'ben-example1@example.org', 'SUCCESS', '2026-11-02', ''],
    ['RR-B-2026-020-0002', 'RR-B-2026-020', 'Example programme', 'BEN-EXAMPLE2', '85.50', 'USD', 'PHONE', '+447700900123', 'UNCLAIMED', '2026-11-02', ''],
  ]);
}

interface SeedItemRow {
  payment_reference: string;
  batch_reference: string;
  programme: string;
  recipient_reference: string;
  receiver_type: string;
  receiver_value: string;
  amount_minor: number;
  currency: string;
  status: string;
  status_updated_at: string | null;
}

/**
 * A synthetic file that exercises every reconciliation path against the seeded records:
 * new payments, exceptions, a stale pending payment, contradictory rows, a possible duplicate,
 * a duplicated reference, a malformed amount, a provider status conflict and an update to a
 * payment that already has an active case.
 */
export function buildSampleCsv(db: Db, organisationId: string, now: Date): string {
  const recorded = dateOnly(new Date(now.getTime() - 27 * DAY_MS));
  const stale = dateOnly(new Date(now.getTime() - 12 * DAY_MS));
  const recent = dateOnly(new Date(now.getTime() - 2 * DAY_MS));

  const row = (n: number, recipient: string, amount: string, status: string, date: string, errorCode = '', type = 'EMAIL'): Cells => [
    `${SAMPLE_BATCH}-${String(n).padStart(4, '0')}`,
    SAMPLE_BATCH,
    SAMPLE_PROGRAMME,
    recipient,
    amount,
    'USD',
    type,
    type === 'EMAIL' ? `${recipient.toLowerCase()}@example.org` : recipient,
    status,
    date,
    errorCode,
  ];

  const rows: Cells[] = [
    row(1, 'BEN-S19A01', '150.00', 'SUCCESS', recorded),
    row(2, 'BEN-S19A02', '150.00', 'SUCCESS', recorded),
    row(3, 'BEN-S19A03', '200.00', 'SUCCESS', recorded),
    row(4, 'BEN-S19A04', '200.00', 'SUCCESS', recorded),
    row(5, 'BEN-S19A05', '175.00', 'SUCCESS', recorded),
    row(6, 'BEN-S19A06', '175.00', 'SUCCESS', recorded),
    row(7, 'BEN-S19A07', '250.00', 'SUCCESS', recorded),
    [...row(8, 'BEN-S19A08', '250.00', 'SUCCESS', recorded).slice(0, 6), 'PHONE', '+447700900481', 'SUCCESS', recorded, ''] as Cells,
    row(9, 'BEN-S19A09', '150.00', 'UNCLAIMED', recorded),
    row(10, 'BEN-S19A10', '200.00', 'UNCLAIMED', recorded),
    row(11, 'BEN-S19A11', '175.00', 'FAILED', recorded, 'RECEIVER_ACCOUNT_LOCKED'),
    row(12, 'BEN-S19A12', '150.00', 'PENDING', stale),
    row(13, 'BEN-S19A13', '200.00', 'SUCCESS', recorded, 'RECEIVER_UNREGISTERED'),
    row(14, 'BEN-S19A14', '250.00', 'SUCCESS', recorded),
    row(15, 'BEN-S19A14', '250.00', 'SUCCESS', recorded),
    row(16, 'BEN-S19A16', '150.00', 'SUCCESS', recorded),
    row(16, 'BEN-S19A17', '175.00', 'SUCCESS', recorded),
    row(18, 'BEN-S19A18', '1,200.00', 'SUCCESS', recorded),
  ];

  const seeded = (batchReference: string, status: string) =>
    db
      .prepare(
        `SELECT i.payment_reference, b.reference AS batch_reference, b.programme, i.recipient_reference, i.receiver_type, i.receiver_value,
           i.amount_minor, i.currency, p.status, p.status_updated_at
         FROM payment_items i
         JOIN payment_batches b ON b.id = i.batch_id
         JOIN provider_transactions p ON p.payment_item_id = i.id
         WHERE i.organisation_id = ? AND b.reference = ? AND p.status = ? AND i.recovery_of_item_id IS NULL
         ORDER BY i.payment_reference LIMIT 1`,
      )
      .get(organisationId, batchReference, status) as SeedItemRow | undefined;

  const existing = (item: SeedItemRow, recordedStatus: string, date: string, errorCode = ''): Cells => [
    item.payment_reference,
    item.batch_reference,
    item.programme,
    item.recipient_reference,
    decimal(item.amount_minor),
    item.currency,
    item.receiver_type,
    item.receiver_value,
    recordedStatus,
    date,
    errorCode,
  ];

  const delivered = seeded('RR-B-2026-017', 'SUCCESS');
  if (delivered) rows.push(existing(delivered, 'FAILED', recent, 'RECEIVER_ACCOUNT_LOCKED'));
  const unclaimed = seeded('RR-B-2026-015', 'UNCLAIMED');
  if (unclaimed) rows.push(existing(unclaimed, 'UNCLAIMED', unclaimed.status_updated_at ? unclaimed.status_updated_at.slice(0, 10) : recorded));

  return toCsv(rows);
}
