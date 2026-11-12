import { ArrowRight, CircleCheck, Info, OctagonExclamationPoint, TriangleExclamationPoint, type LucideIcon } from 'lucide-react';
import { wholeDaysUntil } from '@shared/domain/cases';
import { UNCLAIMED_AUTO_RETURN_DAYS } from '@shared/domain/paypal';
import type { ApprovalSources } from '@shared/api/contracts';
import type { AttentionItem, AttentionSeverity } from '@shared/domain/overview';
import { formatDate, plural } from '../../lib/format';
import { ButtonLink } from '../ui/Button';
import { MoneyTotals } from '../ui/MoneyTotals';
import { EmptyState } from '../ui/States';

const SEVERITY: Record<AttentionSeverity, { label: string; icon: LucideIcon }> = {
  critical: { label: 'Urgent', icon: OctagonExclamationPoint },
  warning: { label: 'Action needed', icon: TriangleExclamationPoint },
  info: { label: 'Monitor', icon: Info },
};

interface Copy {
  title: string;
  detail: string;
  cta: string;
}

function approvalDetail(sources: ApprovalSources | undefined): string {
  const rule = 'Nothing is paid until an approver who did not propose it reviews the evidence and confirms.';
  if (!sources) return rule;
  const parts = [
    sources.historicalAwaitingCases > 0 &&
      `${plural(sources.historicalAwaitingCases, 'case')} from the synthetic history reached this state before the Approval centre existed and ${sources.historicalAwaitingCases === 1 ? 'has' : 'have'} no payment proposal`,
    sources.pendingProposals > 0 && `${plural(sources.pendingProposals, 'current proposal')} ${sources.pendingProposals === 1 ? 'is' : 'are'} waiting in the Approval centre`,
  ].filter(Boolean);
  return `${parts.length > 0 ? `${parts.join('; ')}. ` : ''}${rule}`;
}

function describe(item: AttentionItem, now: Date, sources: ApprovalSources | undefined): Copy {
  switch (item.kind) {
    case 'unclaimed_return_imminent': {
      const due = item.earliestDueAt;
      const days = due ? Math.max(0, wholeDaysUntil(due, now)) : null;
      return {
        title: `${plural(item.count, 'unclaimed payout')} will return to sender soon`,
        detail: `PayPal returns unclaimed payouts after ${UNCLAIMED_AUTO_RETURN_DAYS} days.${
          due ? ` The earliest is expected around ${formatDate(due)} (${plural(days ?? 0, 'day')} from now).` : ''
        } Ask the programme team to contact recipients before then.`,
        cta: 'Review unclaimed cases',
      };
    }
    case 'awaiting_approval':
      return {
        title: `${plural(item.count, 'case')} awaiting approval`,
        detail: approvalDetail(sources),
        cta: 'Open approval centre',
      };
    case 'blocked_compliance':
      return {
        title: `${plural(item.count, 'blocked payout')} need${item.count === 1 ? 's' : ''} compliance review`,
        detail: 'Blocked payouts must not be retried until compliance has reviewed the case.',
        cta: 'Review blocked cases',
      };
    case 'provider_hold':
      return {
        title: `${plural(item.count, 'payout')} held by the provider`,
        detail: 'No operator action is possible until the provider releases or rejects the payout. Monitor for updates.',
        cta: 'View held cases',
      };
    case 'uninvestigated':
      return {
        title: `${plural(item.count, 'case')} not yet investigated`,
        detail: 'These cases were opened automatically from provider statuses or imported records and have no assigned operator.',
        cta: 'Start investigating',
      };
  }
}

export function AttentionList({ items, asOf, approvalSources }: { items: AttentionItem[]; asOf: string; approvalSources?: ApprovalSources }) {
  if (items.length === 0) {
    return (
      <EmptyState icon={CircleCheck} title="Nothing needs attention">
        Every undelivered payment is either progressing or already assigned.
      </EmptyState>
    );
  }
  const now = new Date(asOf);
  return (
    <ul role="list" className="rr-attention">
      {items.map((item) => {
        const copy = describe(item, now, approvalSources);
        const severity = SEVERITY[item.severity];
        const Icon = severity.icon;
        return (
          <li key={item.kind} className={`rr-attention__item rr-attention__item--${item.severity}`}>
            <div className="rr-attention__body">
              <p className={`rr-attention__severity rr-tone--${item.severity}`}>
                <Icon size={14} strokeWidth={2.25} aria-hidden="true" />
                <span>{severity.label}</span>
              </p>
              <h3 className="rr-attention__title">{copy.title}</h3>
              <p className="rr-attention__detail">{copy.detail}</p>
            </div>
            <div className="rr-attention__aside">
              <p className="rr-attention__value rr-num">
                <span className="rr-visually-hidden">Value: </span>
                <MoneyTotals totals={item.value} />
              </p>
              <ButtonLink to={item.href} size="sm" variant="secondary" icon={<ArrowRight size={14} aria-hidden="true" />} iconPosition="end">
                {copy.cta}
              </ButtonLink>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
