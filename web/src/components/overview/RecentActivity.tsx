import { Activity, CircleCheck, FileSpreadsheet, FileStack, GitCompareArrows, Inbox, Send, ShieldCheck, UserCheck, type LucideIcon } from 'lucide-react';
import { CASE_STATE_INFO } from '@shared/domain/cases';
import type { OverviewEvent } from '@shared/domain/overview';
import { PAYOUT_ITEM_STATUS_INFO } from '@shared/domain/paypal';
import type { Tone } from '../ui/Badge';
import { DateTime } from '../ui/DateTime';
import { EmptyState } from '../ui/States';
import { EventSourceLabel, PROVIDER_STATUS_VISUAL } from '../status/StatusBadges';

function presentation(event: OverviewEvent): { title: string; icon: LucideIcon; tone: Tone } {
  switch (event.type) {
    case 'provider_status_changed': {
      const status = event.newStatus ?? 'PENDING';
      const visual = PROVIDER_STATUS_VISUAL[status];
      return { title: `Provider reported ${PAYOUT_ITEM_STATUS_INFO[status].label.toLowerCase()}`, icon: visual.icon, tone: visual.tone };
    }
    case 'case_opened':
      return { title: `Case ${event.caseReference ?? ''} opened`, icon: Inbox, tone: 'info' };
    case 'case_state_changed': {
      const state = event.newCaseState;
      const label = state ? CASE_STATE_INFO[state].label.toLowerCase() : 'a new state';
      const title = `Case ${event.caseReference ?? ''} moved to ${label}`;
      if (state === 'awaiting_approval') return { title, icon: ShieldCheck, tone: 'warning' };
      if (state === 'resolved') return { title, icon: CircleCheck, tone: 'success' };
      return { title, icon: Activity, tone: 'progress' };
    }
    case 'recovery_submitted':
      return { title: `Recovery payment submitted for ${event.caseReference ?? 'case'}`, icon: Send, tone: 'progress' };
    case 'batch_imported':
      return { title: `Batch ${event.batchReference} imported`, icon: FileStack, tone: 'neutral' };
    case 'batch_submitted':
      return { title: `Batch ${event.batchReference} submitted to provider`, icon: Send, tone: 'neutral' };
    case 'status_observed': {
      const status = event.newStatus ?? 'PENDING';
      const visual = PROVIDER_STATUS_VISUAL[status];
      return { title: `Imported record shows ${PAYOUT_ITEM_STATUS_INFO[status].label.toLowerCase()}`, icon: FileSpreadsheet, tone: visual.tone };
    }
    case 'finding_recorded':
      return { title: 'Reconciliation finding recorded', icon: GitCompareArrows, tone: 'warning' };
    case 'case_assigned':
      return { title: `Case ${event.caseReference ?? ''} assigned`, icon: UserCheck, tone: 'progress' };
  }
}

export function RecentActivity({ events, asOf }: { events: OverviewEvent[]; asOf: string }) {
  if (events.length === 0) {
    return <EmptyState icon={Activity} title="No activity yet" />;
  }
  const now = new Date(asOf);
  return (
    <ol role="list" className="rr-activity">
      {events.map((event) => {
        const { title, icon: Icon, tone } = presentation(event);
        return (
          <li key={event.id} className="rr-activity__item">
            <span className={`rr-activity__icon rr-tone-bg--${tone}`} aria-hidden="true">
              <Icon size={14} strokeWidth={2.25} />
            </span>
            <div className="rr-activity__body">
              <p className="rr-activity__title">{title}</p>
              {event.providerEventType ? (
                <p className="rr-activity__summary">
                  <span className="rr-visually-hidden">Provider event </span>
                  <span className="rr-mono">{event.providerEventType}</span>
                </p>
              ) : (
                <p className="rr-activity__summary">{event.summary}</p>
              )}
              <p className="rr-activity__meta">
                {event.paymentReference && <span className="rr-mono">{event.paymentReference}</span>}
                {event.actorName && <span>{event.actorName}</span>}
                <EventSourceLabel source={event.source} />
                <DateTime value={event.occurredAt} format="relative" now={now} />
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
