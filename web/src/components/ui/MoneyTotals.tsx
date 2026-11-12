import type { MoneyTotals as Totals } from '@shared/domain/money';
import { formatMoneyValue } from '../../lib/format';

/** Per-currency subtotals, one line per currency. Different currencies are never added together. */
export function MoneyTotals({ totals }: { totals: Totals }) {
  if (totals.length === 0) return <>None</>;
  if (totals.length === 1) return <>{formatMoneyValue(totals[0]!)}</>;
  return (
    <span className="rr-money-totals">
      {totals.map((t) => (
        <span key={t.currency} className="rr-money-totals__item">
          {formatMoneyValue(t)}
        </span>
      ))}
      <span className="rr-visually-hidden"> (separate subtotals per currency, not added together)</span>
    </span>
  );
}
