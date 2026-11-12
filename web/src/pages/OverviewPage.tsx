import { CircleCheck, Clock, FileUp, HandCoins, Inbox, RefreshCw, ShieldCheck } from 'lucide-react';
import type { ApprovalSources, OverviewResponse } from '@shared/api/contracts';
import { AttentionList } from '../components/overview/AttentionList';
import { BatchTable } from '../components/overview/BatchTable';
import { ExceptionBreakdown } from '../components/overview/ExceptionBreakdown';
import { JudgeScenarioPanel } from '../components/overview/JudgeScenarioPanel';
import { OutcomeSummary } from '../components/overview/OutcomeSummary';
import { RecentActivity } from '../components/overview/RecentActivity';
import { Button, ButtonLink } from '../components/ui/Button';
import { DateTime } from '../components/ui/DateTime';
import { MoneyTotals } from '../components/ui/MoneyTotals';
import { PageHeader } from '../components/ui/PageHeader';
import { Panel } from '../components/ui/Panel';
import { Stat } from '../components/ui/Stat';
import { ErrorState, LoadingState } from '../components/ui/States';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useOverview } from '../hooks/useOverview';
import { useSession } from '../hooks/useSession';
import { formatCount, formatMoneyTotals, plural } from '../lib/format';

export function OverviewPage() {
  useDocumentTitle('Overview');
  const { data, error, isPending, isError, isFetching, refetch } = useOverview();
  const { data: session } = useSession();

  return (
    <div className="rr-page">
      <PageHeader
        title="Overview"
        description={
          data ? (
            <>
              Whether payments are reaching recipients, what remains undelivered, and what needs a decision. Computed from{' '}
              {plural(data.payments.count, 'payment record')} as of <DateTime value={data.asOf} />.
            </>
          ) : (
            'Whether payments are reaching recipients, what remains undelivered, and what needs a decision.'
          )
        }
        actions={
          <>
            <Button
              icon={<RefreshCw size={16} aria-hidden="true" />}
              onClick={() => void refetch()}
              loading={isFetching && !isPending}
              disabled={isPending}
            >
              Refresh
            </Button>
            {!session?.environment.publicReadOnly && (
              <ButtonLink to="/import" variant="primary" icon={<FileUp size={16} aria-hidden="true" />}>
                Import batch
              </ButtonLink>
            )}
          </>
        }
      />

      {isPending && (
        <div className="rr-overview-grid">
          <div className="rr-panel rr-span-full">
            <LoadingState label="Loading payment overview" rows={4} />
          </div>
        </div>
      )}
      {isError && (
        <ErrorState title="The overview could not be loaded" error={error} onRetry={() => void refetch()} retrying={isFetching} />
      )}
      {data && <OverviewContent overview={data} judgeDemo={session?.environment.judgeDemo === true} />}
    </div>
  );
}

/** Names who received the payouts, so simulated stub payouts never read as genuine PayPal Sandbox payouts. */
function sentPayoutsText(sources: ApprovalSources): string {
  if (sources.paypalTarget === 'local_stub') return `${plural(sources.submittedPayouts, 'simulated payout')} sent (local PayPal stub, not PayPal)`;
  return `${plural(sources.submittedPayouts, 'genuine PayPal Sandbox payout')} sent`;
}

function OverviewContent({ overview, judgeDemo }: { overview: OverviewResponse; judgeDemo: boolean }) {
  const outcome = (key: OverviewResponse['outcomes'][number]['outcome']) => overview.outcomes.find((o) => o.outcome === key);
  const inProgress = outcome('in_progress')?.count ?? 0;
  const requiresAction = outcome('requires_action')?.count ?? 0;
  const recovered = outcome('recovered');
  const { byState } = overview.cases;
  const sources = overview.approvalSources;

  return (
    <div className="rr-overview-grid">
      {judgeDemo && <JudgeScenarioPanel />}
      <Panel
        className="rr-span-full"
        title="Delivery status"
        description="Each intended payment is counted once, using the latest provider status. Imported records without a provider record are shown as unconfirmed. Recovery attempts are not counted as extra payments."
      >
        <OutcomeSummary overview={overview} />
      </Panel>

      <dl className="rr-stats rr-span-full" aria-label="Key figures">
        <Stat
          label="Undelivered value by currency"
          icon={Clock}
          tone="warning"
          value={<MoneyTotals totals={overview.outstanding.value} />}
          supporting={`${plural(overview.outstanding.count, 'payment')}: ${formatCount(requiresAction)} requiring action, ${formatCount(inProgress)} in progress`}
        />
        <Stat
          label="Active cases"
          icon={Inbox}
          tone="info"
          value={formatCount(overview.cases.active)}
          supporting={`${formatCount(byState.open)} open · ${formatCount(byState.investigating)} investigating · ${formatCount(byState.awaiting_approval)} awaiting approval`}
        />
        <Stat
          label="Cases awaiting approval"
          icon={ShieldCheck}
          tone="warning"
          value={formatCount(byState.awaiting_approval)}
          supporting={`${formatMoneyTotals(overview.cases.awaitingApprovalValue)} in these cases. ${formatCount(sources.historicalAwaitingCases)} from the synthetic history (no payment proposal) · ${plural(sources.pendingProposals, 'current proposal')} in the Approval centre · ${sentPayoutsText(sources)}`}
        />
        <Stat
          label="Recovered by currency"
          icon={HandCoins}
          tone="success"
          value={<MoneyTotals totals={recovered?.value ?? []} />}
          supporting={`${plural(recovered?.count ?? 0, 'payment')} delivered through approved reissues`}
        />
      </dl>

      <Panel
        className="rr-span-main"
        title="Requires attention"
        description="Derived from provider statuses, imported records, deadlines and case states. Ordered by urgency."
      >
        <AttentionList items={overview.attention} asOf={overview.asOf} approvalSources={sources} />
      </Panel>

      <Panel
        className="rr-span-side"
        title="Undelivered by reported status"
        description="Payments requiring action, grouped by the provider's status or, where there is no provider record, the imported record."
      >
        <ExceptionBreakdown rows={overview.exceptionsByStatus} />
      </Panel>

      <Panel
        className="rr-span-main"
        title="Payment batches"
        description="Delivery progress for each batch, submitted or imported, most recent first."
        flush
      >
        <BatchTable batches={overview.batches} />
      </Panel>

      <Panel className="rr-span-side" title="Recent activity" description="Latest provider, system and operator events.">
        <RecentActivity events={overview.recentEvents} asOf={overview.asOf} />
      </Panel>

      <p className="rr-span-full rr-footnote">
        <CircleCheck size={14} aria-hidden="true" />
        Figures are calculated on the server from payment records each time this page loads. Delivery is only counted when the
        provider reports it, never when a request is merely submitted. Amounts are shown as separate GBP, USD and EUR subtotals and
        are never converted or added across currencies; bar lengths show payment counts, not money.
      </p>
    </div>
  );
}
