import { Inbox } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { PROPOSAL_ACTION_INFO, PROPOSAL_STATUS_INFO, PROPOSAL_STATUSES, type ProposalStatus } from '@shared/domain/payouts';
import { ProposalStatusBadge, SandboxNotice } from '../components/payouts/PayoutBadges';
import { DateTime } from '../components/ui/DateTime';
import { PageHeader } from '../components/ui/PageHeader';
import { Panel } from '../components/ui/Panel';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { usePayPalTarget } from '../hooks/usePayPalTarget';
import { useProposals } from '../hooks/usePayouts';
import { formatMoneyValue } from '../lib/format';

type Filter = ProposalStatus | 'all';
const isFilter = (v: string | null): v is Filter => v === 'all' || (PROPOSAL_STATUSES as readonly string[]).includes(v ?? '');

export function ApprovalsPage() {
  useDocumentTitle('Approval centre');
  const [params, setParams] = useSearchParams();
  const raw = params.get('status');
  const status: Filter = isFilter(raw) ? raw : 'pending_approval';
  const { data, error, isPending, isError, refetch, isFetching } = useProposals(status);
  const { t } = usePayPalTarget();

  return (
    <div className="rr-page">
      <PageHeader
        title="Approval centre"
        description={t('Proposed PayPal Sandbox recovery actions. An approver who did not make the proposal reviews the evidence and types a confirmation before anything is sent.')}
      />
      <div className="rr-stack">
        <SandboxNotice />
        <Panel
          title="Proposals"
          flush
          actions={
            <div className="rr-field rr-field--inline">
              <label htmlFor="proposal-status" className="rr-field__label">
                Status
              </label>
              <select
                id="proposal-status"
                className="rr-select"
                value={status}
                onChange={(e) => setParams(e.target.value === 'pending_approval' ? {} : { status: e.target.value })}
              >
                {PROPOSAL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(PROPOSAL_STATUS_INFO[s].label)}
                    {data ? ` (${data.counts[s]})` : ''}
                  </option>
                ))}
                <option value="all">All proposals</option>
              </select>
            </div>
          }
        >
          {isPending && <LoadingState label="Loading proposals" rows={4} />}
          {isError && (
            <div className="rr-panel__inset">
              <ErrorState title="Proposals could not be loaded" error={error} onRetry={() => void refetch()} retrying={isFetching} />
            </div>
          )}
          {data && data.proposals.length === 0 && (
            <div className="rr-panel__inset">
              <EmptyState icon={Inbox} title={status === 'pending_approval' ? 'Nothing is waiting for approval' : 'No proposals with this status'}>
                Proposals are made from a payment case by a payment operator or administrator. Cases in the synthetic history that show
                “awaiting approval” were recorded before the Approval centre existed and have no payment proposal, so they are not listed here.
              </EmptyState>
            </div>
          )}
          {data && data.proposals.length > 0 && (
            <div className="rr-table-scroll" role="region" aria-label="Proposals table" tabIndex={0}>
              <table className="rr-table">
                <thead>
                  <tr>
                    <th scope="col">Proposal</th>
                    <th scope="col">Case</th>
                    <th scope="col" className="rr-table__num">
                      Amount
                    </th>
                    <th scope="col">Proposed</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.proposals.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link to={`/approvals/${p.id}`} className="rr-strong-link">
                          {t(PROPOSAL_ACTION_INFO[p.action].label)}
                        </Link>
                        <span className="rr-table__secondary">
                          Payment <span className="rr-mono">{p.paymentReference}</span>
                          {p.attemptNumber ? ` · attempt ${p.attemptNumber}` : ''}
                        </span>
                      </td>
                      <td>
                        <Link to={`/cases/${p.caseId}`} className="rr-mono">
                          {p.caseReference}
                        </Link>
                      </td>
                      <td className="rr-table__num rr-num">{formatMoneyValue(p.amount)}</td>
                      <td>
                        {p.proposedBy.displayName}
                        <span className="rr-table__secondary">
                          <DateTime value={p.proposedAt} />
                        </span>
                      </td>
                      <td>
                        <ProposalStatusBadge status={p.status} size="sm" />
                        <span className="rr-table__secondary">
                          {p.status === 'pending_approval' ? (
                            <>
                              Expires <DateTime value={p.expiresAt} />
                            </>
                          ) : p.decidedBy ? (
                            `By ${p.decidedBy.displayName}`
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
