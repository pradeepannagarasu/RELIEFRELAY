import { ArrowLeft, CircleX, History, ShieldCheck, Undo2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { PaymentAttemptView, ProposalDetail } from '@shared/api/contracts';
import { CASE_STATE_INFO } from '@shared/domain/cases';
import { PROPOSAL_ACTION_INFO, PROPOSAL_REASON_INFO } from '@shared/domain/payouts';
import { CancellationStateBadge, PayPalModeBadge, ProposalStatusBadge, SandboxNotice, ServerChecks, SubmissionStateBadge } from '../components/payouts/PayoutBadges';
import { BatchStatusBadge, ProviderStatusBadge } from '../components/status/StatusBadges';
import { Button } from '../components/ui/Button';
import { DateTime } from '../components/ui/DateTime';
import { PageHeader } from '../components/ui/PageHeader';
import { Panel } from '../components/ui/Panel';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { usePayPalTarget } from '../hooks/usePayPalTarget';
import { useDecideProposal, useProposal } from '../hooks/usePayouts';
import { formatMoneyValue } from '../lib/format';
import { ApiError } from '../services/apiClient';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rr-facts__item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function AttemptRow({ a }: { a: PaymentAttemptView }) {
  return (
    <tr>
      <td>
        {a.kind === 'original' ? 'Original' : `Recovery ${a.attemptNumber ?? ''}`}
        <span className="rr-table__secondary rr-mono">{a.reference}</span>
      </td>
      <td className="rr-table__num rr-num">{formatMoneyValue(a.amount)}</td>
      <td>
        {a.provider ? (
          <div className="rr-badge-row">
            <ProviderStatusBadge status={a.provider.status} size="sm" />
            <PayPalModeBadge mode={a.provider.mode} />
          </div>
        ) : (
          'No provider record'
        )}
      </td>
      <td>{a.batch.status ? <BatchStatusBadge status={a.batch.status} size="sm" /> : '—'}</td>
    </tr>
  );
}

function Decision({ proposal }: { proposal: ProposalDetail }) {
  const decide = useDecideProposal(proposal.id, proposal.caseId);
  const [confirmation, setConfirmation] = useState('');
  const [reason, setReason] = useState('');
  const id = useId();
  const { permissions } = proposal;
  const matches = confirmation === proposal.confirmationPhrase;
  const allPassed = proposal.checks.every((c) => c.passed);
  const { t } = usePayPalTarget();

  if (proposal.status !== 'pending_approval') return null;
  if (!permissions.canApprove && !permissions.canReject && !permissions.canWithdraw) {
    return (
      <Panel title="Decision">
        <p className="rr-muted">{permissions.reason ?? 'Your role cannot decide this proposal.'}</p>
      </Panel>
    );
  }

  return (
    <Panel
      title="Decision"
      description={t('Approving submits the payout to PayPal Sandbox immediately, with test money only. Every check above is run again on the server at that moment.')}
    >
      <div className="rr-stack">
        {permissions.canApprove ? (
          <form
            className="rr-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (matches) decide.mutate({ kind: 'approve', body: { proposalVersion: proposal.version, confirmation } });
            }}
          >
            <div className="rr-field">
              <label htmlFor={`${id}-confirm`} className="rr-field__label">
                Type <span className="rr-mono rr-confirm-phrase">{proposal.confirmationPhrase}</span> to confirm
              </label>
              <p id={`${id}-confirm-hint`} className="rr-field__hint">
                Must match exactly, including the amount and currency.
              </p>
              <input
                id={`${id}-confirm`}
                className="rr-input rr-mono"
                autoComplete="off"
                spellCheck={false}
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                aria-describedby={`${id}-confirm-hint`}
              />
            </div>
            {!allPassed && (
              <p className="rr-notice rr-notice--warning">
                <CircleX size={16} aria-hidden="true" />
                <span>Some checks are not met. The server will refuse approval until they are.</span>
              </p>
            )}
            <div className="rr-form__actions">
              <Button
                type="submit"
                variant="primary"
                icon={<ShieldCheck size={16} aria-hidden="true" />}
                loading={decide.isPending && decide.variables?.kind === 'approve'}
                disabled={!matches}
              >
                {t(proposal.action === 'reissue' ? 'Approve and submit to PayPal Sandbox' : 'Approve and cancel in PayPal Sandbox')}
              </Button>
            </div>
          </form>
        ) : (
          permissions.reason && <p className="rr-muted">{permissions.reason}</p>
        )}

        {(permissions.canReject || permissions.canWithdraw) && (
          <form className="rr-form" noValidate onSubmit={(e) => e.preventDefault()}>
            <div className="rr-field">
              <label htmlFor={`${id}-reason`} className="rr-field__label">
                Reason for {permissions.canReject ? 'rejecting' : 'withdrawing'}
              </label>
              <p id={`${id}-reason-hint`} className="rr-field__hint">
                At least 5 characters. No email addresses or phone numbers.
              </p>
              <textarea id={`${id}-reason`} className="rr-textarea" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby={`${id}-reason-hint`} />
            </div>
            <div className="rr-form__actions">
              {permissions.canReject && (
                <Button
                  icon={<CircleX size={16} aria-hidden="true" />}
                  loading={decide.isPending && decide.variables?.kind === 'reject'}
                  disabled={reason.trim().length < 5}
                  onClick={() => decide.mutate({ kind: 'reject', body: { proposalVersion: proposal.version, reason: reason.trim() } })}
                >
                  Reject
                </Button>
              )}
              {permissions.canWithdraw && (
                <Button
                  icon={<Undo2 size={16} aria-hidden="true" />}
                  loading={decide.isPending && decide.variables?.kind === 'withdraw'}
                  disabled={reason.trim().length < 5}
                  onClick={() => decide.mutate({ kind: 'withdraw', body: { proposalVersion: proposal.version, reason: reason.trim() } })}
                >
                  Withdraw proposal
                </Button>
              )}
            </div>
          </form>
        )}
        {decide.isError && (
          <p className="rr-inline-error" role="alert">
            {decide.error.message}
            {decide.error instanceof ApiError && decide.error.status === 409 && ' The latest details have been loaded.'}
          </p>
        )}
      </div>
    </Panel>
  );
}

function Outcome({ proposal }: { proposal: ProposalDetail }) {
  const { submission, cancellation } = proposal;
  const { t } = usePayPalTarget();
  if (!submission && !cancellation) return null;
  return (
    <Panel title="Outcome" description="Batch acceptance and the individual payout item's status are tracked separately.">
      <SandboxNotice text={proposal.sandboxNotice} />
      {submission && (
        <dl className="rr-facts rr-section-gap">
          <Fact label="Submission">
            <SubmissionStateBadge state={submission.state} />
          </Fact>
          <Fact label="Sender batch ID">
            <span className="rr-mono">{submission.senderBatchId}</span>
          </Fact>
          {submission.providerBatchId && (
            <Fact label={t('PayPal Sandbox batch ID')}>
              <span className="rr-mono">{submission.providerBatchId}</span>
            </Fact>
          )}
          <Fact label="Attempts">
            <span className="rr-num">
              {submission.attemptCount} of {submission.maxAttempts}
            </span>
          </Fact>
          {submission.recoveryItem && (
            <Fact label="Recovery payment">
              <span className="rr-mono">{submission.recoveryItem.reference}</span>
            </Fact>
          )}
        </dl>
      )}
      {cancellation && (
        <dl className="rr-facts rr-section-gap">
          <Fact label="Cancellation">
            <CancellationStateBadge state={cancellation.state} />
          </Fact>
          <Fact label="Target">
            <span className="rr-mono">{cancellation.targetItem.reference}</span>
          </Fact>
          <Fact label="Requests sent">
            <span className="rr-num">
              {cancellation.sendCount} of {cancellation.maxSends}
            </span>
          </Fact>
        </dl>
      )}
      <p className="rr-field__hint rr-section-gap">
        Full detail, including the item status, is on the <Link to={`/cases/${proposal.caseId}`}>case page</Link>.
      </p>
    </Panel>
  );
}

export function ProposalPage() {
  const { id = '' } = useParams();
  const { data, error, isPending, isError, refetch, isFetching } = useProposal(id);
  const proposal = data?.proposal;
  useDocumentTitle(proposal ? `Proposal for ${proposal.paymentReference}` : 'Proposal');
  const { t } = usePayPalTarget();

  return (
    <div className="rr-page">
      <PageHeader
        eyebrow={
          <Link to="/approvals" className="rr-back-link">
            <ArrowLeft size={14} aria-hidden="true" />
            Approval centre
          </Link>
        }
        title={proposal ? `${t(PROPOSAL_ACTION_INFO[proposal.action].label)}: ${proposal.paymentReference}` : 'Proposal'}
        description={proposal ? t(PROPOSAL_ACTION_INFO[proposal.action].description) : undefined}
        actions={proposal ? <ProposalStatusBadge status={proposal.status} /> : undefined}
      />
      {isPending && <LoadingState label="Loading proposal" rows={5} />}
      {isError &&
        (error instanceof ApiError && error.status === 404 ? (
          <EmptyState icon={History} title="Proposal not found">
            <Link to="/approvals">Back to the approval centre</Link>.
          </EmptyState>
        ) : (
          <ErrorState title="This proposal could not be loaded" error={error} onRetry={() => void refetch()} retrying={isFetching} />
        ))}
      {proposal && (
        <div className="rr-stack">
          <SandboxNotice text={proposal.sandboxNotice} />
          <div className="rr-two-column">
            <Panel title="Proposed action">
              <dl className="rr-facts">
                <Fact label="Action">{t(PROPOSAL_ACTION_INFO[proposal.action].label)}</Fact>
                <Fact label="Amount">
                  <span className="rr-num">{formatMoneyValue(proposal.amount)}</span>
                </Fact>
                <Fact label="Receiver">{proposal.receiverMasked} (original receiver)</Fact>
                <Fact label="Target payment">
                  <span className="rr-mono">{proposal.target.reference}</span>
                </Fact>
                {proposal.attemptNumber && <Fact label="Attempt">{proposal.attemptNumber}</Fact>}
                <Fact label="Reason">{PROPOSAL_REASON_INFO[proposal.reasonCode].label}</Fact>
                <Fact label="Justification">{proposal.justification}</Fact>
                <Fact label="Proposed by">
                  {proposal.proposedBy.displayName}, <DateTime value={proposal.proposedAt} />
                </Fact>
                <Fact label={proposal.status === 'pending_approval' ? 'Expires' : 'Decided'}>
                  {proposal.status === 'pending_approval' ? (
                    <DateTime value={proposal.expiresAt} />
                  ) : proposal.decidedAt ? (
                    <>
                      {proposal.decidedBy?.displayName ?? 'ReliefRelay'}, <DateTime value={proposal.decidedAt} />
                    </>
                  ) : (
                    '—'
                  )}
                </Fact>
                {proposal.decisionReason && <Fact label="Decision reason">{proposal.decisionReason}</Fact>}
                <Fact label="Case">
                  <Link to={`/cases/${proposal.caseId}`} className="rr-mono">
                    {proposal.caseReference}
                  </Link>{' '}
                  ({CASE_STATE_INFO[proposal.caseState].label})
                </Fact>
              </dl>
            </Panel>
            <Panel title="Payment and recovery attempts" description="Each payout item's status, with its batch status shown separately." flush>
              <div className="rr-table-scroll" role="region" aria-label="Payment attempts table" tabIndex={0}>
                <table className="rr-table rr-table--compact">
                  <thead>
                    <tr>
                      <th scope="col">Payment</th>
                      <th scope="col" className="rr-table__num">
                        Amount
                      </th>
                      <th scope="col">Item status</th>
                      <th scope="col">Batch status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposal.attempts.map((a) => (
                      <AttemptRow key={a.itemId} a={a} />
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
          {proposal.status === 'pending_approval' && (
            <Panel title="Server checks" description="Evaluated now by the server. Approval runs every check again inside the same transaction that records it.">
              <ServerChecks checks={proposal.checks} />
            </Panel>
          )}
          <Decision proposal={proposal} />
          <Outcome proposal={proposal} />
          <Panel title="Audit history" description="Entries from the tamper-evident audit log for this proposal, including refused attempts.">
            {proposal.history.length === 0 ? (
              <p className="rr-muted">No audit entries.</p>
            ) : (
              <ol role="list" className="rr-history">
                {proposal.history.map((h) => (
                  <li key={h.seq} className="rr-history__item">
                    <p>
                      <span className="rr-mono">{h.action}</span>{' '}
                      <span className={h.outcome === 'rejected' ? 'rr-tone--critical' : 'rr-muted'}>({h.outcome === 'rejected' ? 'refused' : 'succeeded'})</span>
                    </p>
                    {h.reason && <p className="rr-muted">{h.reason}</p>}
                    <p className="rr-activity__meta">
                      <span>#{h.seq}</span>
                      <span>{h.actor ? `${h.actor.displayName} (${h.actor.role})` : 'ReliefRelay system'}</span>
                      <DateTime value={h.recordedAt} />
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
