import { CircleCheck } from 'lucide-react';
import { sumMoney } from '@shared/domain/money';
import type { StatusTotal } from '@shared/domain/overview';
import { PAYOUT_ITEM_STATUS_INFO } from '@shared/domain/paypal';
import { formatCount, formatMoneyTotals, plural } from '../../lib/format';
import { ProviderStatusBadge } from '../status/StatusBadges';
import { EmptyState } from '../ui/States';

export function ExceptionBreakdown({ rows }: { rows: StatusTotal[] }) {
  if (rows.length === 0) {
    return <EmptyState icon={CircleCheck} title="No undelivered payments need action" />;
  }
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const totalValue = sumMoney(rows.flatMap((r) => r.value));

  return (
    <div className="rr-breakdown">
      <ul role="list" className="rr-breakdown__list">
        {rows.map((row) => (
          <li key={row.status} className="rr-breakdown__row">
            <div className="rr-breakdown__top">
              <ProviderStatusBadge status={row.status} />
              <span className="rr-breakdown__figures rr-num">
                <strong>{formatCount(row.count)}</strong>
                <span className="rr-muted"> · {formatMoneyTotals(row.value)}</span>
              </span>
            </div>
            <div className="rr-breakdown__meter" aria-hidden="true">
              <span style={{ width: `${(row.count / total) * 100}%` }} />
            </div>
            <p className="rr-breakdown__desc">
              {PAYOUT_ITEM_STATUS_INFO[row.status].description}
              {row.unconfirmedCount > 0 &&
                ` ${formatCount(row.unconfirmedCount)} of these ${row.unconfirmedCount === 1 ? 'comes' : 'come'} from imported records only, not from the provider.`}
            </p>
          </li>
        ))}
      </ul>
      <p className="rr-breakdown__total rr-num">
        {plural(total, 'payment')} requiring action. By currency: {formatMoneyTotals(totalValue)}
      </p>
    </div>
  );
}
