import { useId } from 'react';
import { FileSpreadsheet, Layers } from 'lucide-react';
import type { BatchSummary } from '@shared/domain/overview';
import { formatCount, plural } from '../../lib/format';
import { BatchStatusBadge, ProviderModeBadge } from '../status/StatusBadges';
import { Badge } from '../ui/Badge';
import { DateTime } from '../ui/DateTime';
import { MoneyTotals } from '../ui/MoneyTotals';
import { EmptyState } from '../ui/States';

function deliveryNote(batch: BatchSummary): string | null {
  const parts: string[] = [];
  if (batch.outcomes.in_progress > 0) parts.push(`${formatCount(batch.outcomes.in_progress)} in progress`);
  if (batch.outcomes.requires_action > 0) parts.push(`${formatCount(batch.outcomes.requires_action)} need action`);
  if (batch.outcomes.recovered > 0) parts.push(`${formatCount(batch.outcomes.recovered)} recovered`);
  if (batch.outcomes.unconfirmed > 0) parts.push(`${formatCount(batch.outcomes.unconfirmed)} unconfirmed`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function BatchTable({ batches }: { batches: BatchSummary[] }) {
  const captionId = useId();
  if (batches.length === 0) {
    return (
      <EmptyState icon={Layers} title="No payment batches yet">
        Imported batches will appear here once records have passed validation.
      </EmptyState>
    );
  }

  return (
    <div className="rr-table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
      <table className="rr-table rr-table--batches">
        <caption id={captionId} className="rr-visually-hidden">
          Payment batches, most recent first
        </caption>
        <thead>
          <tr>
            <th scope="col">Batch</th>
            <th scope="col" className="rr-table__num">
              Value
            </th>
            <th scope="col">Delivery</th>
            <th scope="col">Source and provider status</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => {
            const reached = batch.outcomes.delivered + batch.outcomes.recovered;
            const share = batch.itemCount > 0 ? (reached / batch.itemCount) * 100 : 0;
            const note = deliveryNote(batch);
            return (
              <tr key={batch.id}>
                <th scope="row" className="rr-table__primary">
                  <span className="rr-batch-ref">
                    <span className="rr-mono">{batch.reference}</span>
                    {batch.kind === 'recovery' && <span className="rr-kind-tag">Recovery</span>}
                  </span>
                  <span className="rr-table__secondary">{batch.programme}</span>
                </th>
                <td className="rr-table__num rr-num">
                  <MoneyTotals totals={batch.totalValue} />
                  <span className="rr-table__secondary">{plural(batch.itemCount, 'payment')}</span>
                </td>
                <td>
                  <div className="rr-delivery">
                    <span className="rr-num">
                      {formatCount(reached)} of {formatCount(batch.itemCount)} delivered
                    </span>
                    <span className="rr-delivery__meter" aria-hidden="true">
                      <span style={{ width: `${share}%` }} />
                    </span>
                    {note && <span className="rr-table__secondary rr-num">{note}</span>}
                  </div>
                </td>
                <td>
                  <div className="rr-badge-row">
                    {batch.status && <BatchStatusBadge status={batch.status} size="sm" />}
                    {batch.providerMode && <ProviderModeBadge mode={batch.providerMode} />}
                    {batch.origin === 'csv_import' && (
                      <Badge tone="neutral" icon={FileSpreadsheet} size="sm" label="Imported records" description="Recorded from an uploaded CSV file. ReliefRelay has not submitted this batch to the provider." />
                    )}
                  </div>
                  <span className="rr-table__secondary rr-nowrap">
                    {batch.submittedAt ? (
                      <>
                        Submitted <DateTime value={batch.submittedAt} format="date" />
                      </>
                    ) : batch.origin === 'csv_import' ? (
                      'Not submitted by ReliefRelay'
                    ) : (
                      'Not submitted'
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
