import { sumMoney } from '@shared/domain/money';
import { PAYMENT_OUTCOME_INFO, type Overview, type PaymentOutcome } from '@shared/domain/overview';
import { formatCount, formatMoneyTotals, formatPercent, plural } from '../../lib/format';

const SERIES_CLASS: Record<PaymentOutcome, string> = {
  delivered: 'rr-series--delivered',
  recovered: 'rr-series--recovered',
  in_progress: 'rr-series--in-progress',
  requires_action: 'rr-series--requires-action',
  unconfirmed: 'rr-series--unconfirmed',
  closed_undelivered: 'rr-series--closed',
};

export function OutcomeSummary({ overview }: { overview: Overview }) {
  const total = overview.payments.count;
  const count = (outcome: PaymentOutcome) => overview.outcomes.find((o) => o.outcome === outcome)?.count ?? 0;
  const reached = count('delivered') + count('recovered');
  const notReached = total - reached;
  const notReachedValue = sumMoney(
    overview.outcomes.filter((o) => o.outcome !== 'delivered' && o.outcome !== 'recovered').flatMap((o) => o.value),
  );
  const textAlternative = overview.outcomes
    .map((o) => `${PAYMENT_OUTCOME_INFO[o.outcome].label}: ${formatCount(o.count)}`)
    .join(', ');
  return (
    <div className="rr-outcome">
      <div className="rr-outcome__headline">
        <p className="rr-outcome__figure rr-num">
          {formatCount(reached)} <span className="rr-outcome__of">of {plural(total, 'payment')} reached recipients</span>
        </p>
        <p className="rr-outcome__sub">
          {total > 0 ? `${formatPercent(reached / total)} delivered, including approved recoveries. ` : ''}
          {notReached > 0
            ? `${plural(notReached, 'payment')} ${notReached === 1 ? 'is' : 'are'} not confirmed as delivered (by currency: ${formatMoneyTotals(notReachedValue)}).`
            : 'Every payment has been delivered.'}
          {count('unconfirmed') > 0
            ? ` ${plural(count('unconfirmed'), 'imported record')} ${count('unconfirmed') === 1 ? 'has' : 'have'} no provider confirmation yet.`
            : ''}
        </p>
      </div>

      {total > 0 && (
        <div className="rr-outcome__bar" role="img" aria-label={`Payment outcomes by number of payments. ${textAlternative}.`}>
          {overview.outcomes
            .filter((o) => o.count > 0)
            .map((o) => (
              <span
                key={o.outcome}
                className={`rr-outcome__segment ${SERIES_CLASS[o.outcome]}`}
                style={{ flexGrow: o.count }}
              />
            ))}
        </div>
      )}

      <ul role="list" className="rr-outcome__legend">
        {overview.outcomes.map((o) => (
          <li key={o.outcome} className="rr-outcome__legend-item">
            <span className={`rr-swatch ${SERIES_CLASS[o.outcome]}`} aria-hidden="true" />
            <div>
              <p className="rr-outcome__legend-label">{PAYMENT_OUTCOME_INFO[o.outcome].label}</p>
              <p className="rr-outcome__legend-value rr-num">
                {formatCount(o.count)}
                <span className="rr-muted"> · {formatMoneyTotals(o.value)}</span>
              </p>
              <p className="rr-outcome__legend-desc">{PAYMENT_OUTCOME_INFO[o.outcome].description}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
