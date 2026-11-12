import { Ban, CircleCheck, Link2, RefreshCw, Search, Send, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CancellationView, DiscrepancyView, LimitUsage, PaymentActionsResponse, PaymentAttemptView, SubmissionView } from '@shared/api/contracts';
import { PROPOSAL_ACTION_INFO, PROPOSAL_REASON_INFO, type ProposalAction, type ProposalReasonCode } from '@shared/domain/payouts';
import {
  useCheckStatus,
  useCreateProposal,
  usePaymentActions,
  useRecheckCancellation,
  useReconcileSubmission,
  useResolveDiscrepancy,
  useRetrySubmission,
} from '../../hooks/usePayouts';
import { usePayPalTarget } from '../../hooks/usePayPalTarget';
import { useSession } from '../../hooks/useSession';
import { formatMoneyValue } from '../../lib/format';
import { BatchStatusBadge, ProviderStatusBadge } from '../status/StatusBadges';
import { Badge } from '../ui/Badge';
import { Button, ButtonLink } from '../ui/Button';
import { DateTime } from '../ui/DateTime';
import { Panel } from '../ui/Panel';
import { ErrorState, LoadingState } from '../ui/States';
import { CancellationStateBadge, PayPalModeBadge, ProposalStatusBadge, SandboxNotice, SubmissionStateBadge } from './PayoutBadges';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rr-facts__item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function MutationError({ error, id }: { error: Error | null; id?: string }) {
  if (!error) return null;
  return (
    <p id={id} className="rr-inline-error" role="alert">
      {error.message}
    </p>
  );
}

function AttemptCard({ attempt, checkable, caseId }: { attempt: PaymentAttemptView; checkable: boolean; caseId: string }) {
  const check = useCheckStatus(caseId);
  const { t } = usePayPalTarget();
  const title = attempt.kind === 'original' ? 'Original payment' : `Recovery attempt ${attempt.attemptNumber ?? ''}`.trim();
  return (
    <section className="rr-attempt" aria-label={`${title} ${attempt.reference}`}>
      <header className="rr-attempt__header">
        <h3 className="rr-attempt__title">
          {title} <span className="rr-mono">{attempt.reference}</span>
        </h3>
        <span className="rr-num">{formatMoneyValue(attempt.amount)}</span>
      </header>
      <div className="rr-attempt__statuses">
        <div className="rr-attempt__status">
          <p className="rr-attempt__label">Payout item status</p>
          {attempt.provider ? (
            <div className="rr-badge-row">
              <ProviderStatusBadge status={attempt.provider.status} size="sm" />
              <PayPalModeBadge mode={attempt.provider.mode} />
            </div>
          ) : (
            <p className="rr-muted">No provider record yet.</p>
          )}
          {attempt.provider && (
            <p className="rr-attempt__meta">
              Updated <DateTime value={attempt.provider.statusUpdatedAt} />
            </p>
          )}
        </div>
        <div className="rr-attempt__status">
          <p className="rr-attempt__label">Batch status (separate from the item)</p>
          {attempt.batch.status ? (
            <div className="rr-badge-row">
              <BatchStatusBadge status={attempt.batch.status} size="sm" />
              {attempt.batch.providerMode && <PayPalModeBadge mode={attempt.batch.providerMode} />}
            </div>
          ) : (
            <p className="rr-muted">No batch status.</p>
          )}
          <p className="rr-attempt__meta">
            Batch <span className="rr-mono">{attempt.batch.reference}</span>
          </p>
        </div>
      </div>
      <dl className="rr-facts rr-facts--compact">
        <Fact label="Receiver">{attempt.receiverMasked}</Fact>
        {attempt.provider?.providerItemId && (
          <Fact label="Provider item ID">
            <span className="rr-mono">{attempt.provider.providerItemId}</span>
          </Fact>
        )}
        <Fact label="Last status check">
          {attempt.latestCheck ? (
            <>
              <DateTime value={attempt.latestCheck.checkedAt} />{' '}
              {attempt.checkFresh ? (
                <Badge tone="success" icon={CircleCheck} size="sm" label="Recent enough to act on" />
              ) : (
                <Badge tone="neutral" icon={RefreshCw} size="sm" label="Older than 15 minutes" />
              )}
            </>
          ) : (
            'None'
          )}
        </Fact>
      </dl>
      {checkable && (
        <div className="rr-form__actions">
          <Button size="sm" icon={<Search size={14} aria-hidden="true" />} loading={check.isPending} onClick={() => check.mutate(attempt.itemId)}>
            {t('Check status with PayPal Sandbox')}
          </Button>
          <span className="rr-field__hint">Read-only: fetches the current item status. Nothing is sent.</span>
        </div>
      )}
      <MutationError error={check.error} />
    </section>
  );
}

function LimitsSummary({ limits }: { limits: LimitUsage }) {
  return (
    <p className="rr-field__hint rr-num">
      Today in {limits.currency}: {limits.payoutsToday} of {limits.maxPayoutsPerDay} payouts,{' '}
      {formatMoneyValue({ currency: limits.currency, minor: limits.valueTodayMinor })} of{' '}
      {formatMoneyValue({ currency: limits.currency, minor: limits.maxValuePerCurrencyPerDayMinor })}. Maximum per payout{' '}
      {formatMoneyValue({ currency: limits.currency, minor: limits.maxPerPayoutMinor })}.
    </p>
  );
}

const JUSTIFICATION_MAX = 1000;

function ProposeForm({ actions }: { actions: PaymentActionsResponse }) {
  const available = (['reissue', 'cancel_unclaimed'] as const).filter((a) => (a === 'reissue' ? actions.reissue.available : actions.cancel.available));
  const [action, setAction] = useState<ProposalAction | null>(available[0] ?? null);
  const option = action === 'reissue' ? actions.reissue : action === 'cancel_unclaimed' ? actions.cancel : null;
  const [reasonCode, setReasonCode] = useState<ProposalReasonCode | ''>('');
  const [justification, setJustification] = useState('');
  const [attested, setAttested] = useState(false);
  const create = useCreateProposal(actions.case.id);
  const id = useId();
  const { t } = usePayPalTarget();

  if (available.length === 0 || !action || !option) return null;
  const reasonCodes = option.reasonCodes;
  const reason = reasonCodes.includes(reasonCode as ProposalReasonCode) ? (reasonCode as ProposalReasonCode) : '';
  const ready = reason !== '' && justification.trim().length >= 10 && attested;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    create.mutate(
      { action, reasonCode: reason, justification: justification.trim(), attestation: true, caseVersion: actions.case.version, providerFingerprint: actions.providerFingerprint },
      {
        onSuccess: () => {
          setJustification('');
          setAttested(false);
          setReasonCode('');
        },
      },
    );
  };

  return (
    <form className="rr-form rr-propose" onSubmit={submit} noValidate aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="rr-subheading">
        Propose a payment action
      </h3>
      <p className="rr-field__hint">A proposal changes nothing by itself. A different person with the approver role must review it and type a confirmation before anything is sent.</p>
      <fieldset className="rr-field">
        <legend className="rr-field__label">Action</legend>
        {available.map((a) => (
          <label key={a} className="rr-radio">
            <input type="radio" name={`${id}-action`} value={a} checked={action === a} onChange={() => setAction(a)} />
            <span>
              <span className="rr-radio__label">{t(PROPOSAL_ACTION_INFO[a].label)}</span>
              <span className="rr-field__hint">{t(PROPOSAL_ACTION_INFO[a].description)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {action === 'reissue' && (
        <dl className="rr-facts rr-facts--compact">
          <Fact label="Amount">
            <span className="rr-num">{formatMoneyValue(actions.reissue.amount)}</span>
          </Fact>
          <Fact label="Receiver">{actions.reissue.receiverMasked} (original receiver only)</Fact>
          <Fact label="Attempt">{actions.reissue.attemptNumber}</Fact>
          {actions.reissue.senderItemId && (
            <Fact label="Sender item ID">
              <span className="rr-mono">{actions.reissue.senderItemId}</span>
            </Fact>
          )}
        </dl>
      )}
      {action === 'cancel_unclaimed' && actions.cancel.target && (
        <p>
          Cancels unclaimed recovery payout <span className="rr-mono">{actions.cancel.target.reference}</span>.{' '}
          {t('If PayPal Sandbox confirms it, the payout is recorded as returned and the case goes back to investigation. Any reissue needs a new proposal and approval.')}
        </p>
      )}
      <div className="rr-field">
        <label htmlFor={`${id}-reason`} className="rr-field__label">
          Reason
        </label>
        <select id={`${id}-reason`} className="rr-select" value={reason} onChange={(e) => setReasonCode(e.target.value as ProposalReasonCode)}>
          <option value="">Choose a reason</option>
          {reasonCodes.map((code) => (
            <option key={code} value={code}>
              {PROPOSAL_REASON_INFO[code].label}
            </option>
          ))}
        </select>
      </div>
      <div className="rr-field">
        <label htmlFor={`${id}-justification`} className="rr-field__label">
          Justification for the approver
        </label>
        <p id={`${id}-hint`} className="rr-field__hint">
          At least 10 characters. Refer to the recipient by programme reference only: no email addresses, phone numbers, names or medical details.
        </p>
        <textarea
          id={`${id}-justification`}
          className="rr-textarea"
          rows={3}
          maxLength={JUSTIFICATION_MAX}
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
          aria-describedby={`${id}-hint ${id}-count`}
        />
        <p id={`${id}-count`} className="rr-field__hint rr-num">
          {justification.length} of {JUSTIFICATION_MAX} characters
        </p>
      </div>
      <label className="rr-checkbox">
        <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
        <span>{t('I have checked the provider status shown above. I understand this goes to the original receiver only, in PayPal Sandbox, and that I cannot approve my own proposal.')}</span>
      </label>
      {option.statusCheckRequired && (
        <p className="rr-notice">
          <RefreshCw size={16} aria-hidden="true" />
          <span>{t('ReliefRelay will fetch the current status from PayPal Sandbox before recording this proposal.')}</span>
        </p>
      )}
      <MutationError error={create.error} />
      {create.isSuccess && (
        <p className="rr-notice" role="status">
          <CircleCheck size={16} aria-hidden="true" />
          <span>
            Proposal recorded. It now waits for an approver: <Link to={`/approvals/${create.data.proposal.id}`}>open the proposal</Link>.
          </span>
        </p>
      )}
      <div className="rr-form__actions">
        <Button type="submit" variant="primary" icon={<ShieldCheck size={16} aria-hidden="true" />} loading={create.isPending} disabled={!ready}>
          Propose for approval
        </Button>
      </div>
    </form>
  );
}

function SubmissionItem({ sub, caseId, canRetry, canReconcile }: { sub: SubmissionView; caseId: string; canRetry: boolean; canReconcile: boolean }) {
  const retry = useRetrySubmission(caseId);
  const reconcile = useReconcileSubmission(caseId);
  const [batchId, setBatchId] = useState('');
  const [note, setNote] = useState('');
  const id = useId();
  const { target, t } = usePayPalTarget();
  const retryable = sub.state === 'not_processed' || sub.state === 'outcome_unknown';
  const reconcilable = retryable || sub.state === 'needs_manual_reconciliation';
  return (
    <li className="rr-action-record">
      <div className="rr-action-record__top">
        <SubmissionStateBadge state={sub.state} size="sm" />
        <span className="rr-mono">{sub.senderBatchId}</span>
      </div>
      <dl className="rr-facts rr-facts--compact">
        <Fact label="Sender item ID">
          <span className="rr-mono">{sub.senderItemId}</span>
        </Fact>
        <Fact label="Approved">
          <DateTime value={sub.approvedAt} />
        </Fact>
        <Fact label="Attempts">
          <span className="rr-num">
            {sub.attemptCount} of {sub.maxAttempts}
          </span>
        </Fact>
        {sub.nextAttemptAt && (
          <Fact label="Next replay">
            <DateTime value={sub.nextAttemptAt} />
          </Fact>
        )}
        <Fact label="Replays stop">
          <DateTime value={sub.replayDeadlineAt} />
        </Fact>
        {sub.providerBatchId && (
          <Fact label={target === 'local_stub' ? 'Stub batch ID (not PayPal)' : 'PayPal batch ID'}>
            <span className="rr-mono">{sub.providerBatchId}</span>
          </Fact>
        )}
        {(sub.lastErrorName || sub.lastHttpStatus) && (
          <Fact label="Last response">
            <span className="rr-mono">
              {sub.lastHttpStatus ? `HTTP ${sub.lastHttpStatus}` : 'No response'} {sub.lastErrorName ?? ''}
            </span>
            {sub.lastDebugId && <span className="rr-table__secondary rr-mono">debug {sub.lastDebugId}</span>}
          </Fact>
        )}
      </dl>
      {canRetry && retryable && (
        <div className="rr-form__actions">
          <Button size="sm" icon={<RefreshCw size={14} aria-hidden="true" />} loading={retry.isPending} onClick={() => retry.mutate(sub.id)}>
            Retry with the same keys
          </Button>
          <span className="rr-field__hint">Replays the identical approved request. PayPal returns the original payout rather than creating a second one.</span>
        </div>
      )}
      <MutationError error={retry.error} />
      {canReconcile && reconcilable && (
        <details className="rr-disclosure rr-section-gap">
          <summary>Administrator reconciliation</summary>
          <form
            className="rr-form rr-section-gap"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (batchId.trim()) reconcile.mutate({ submissionId: sub.id, action: 'link_batch', providerBatchId: batchId.trim(), note: note.trim() || undefined });
            }}
          >
            <div className="rr-field">
              <label htmlFor={`${id}-batch`} className="rr-field__label">
                {t('PayPal Sandbox payout batch ID')}
              </label>
              <p id={`${id}-batch-hint`} className="rr-field__hint">
                {t(`Linked only if PayPal Sandbox shows that batch carrying sender batch ID ${sub.senderBatchId}.`)}
              </p>
              <input id={`${id}-batch`} className="rr-input rr-mono" value={batchId} onChange={(e) => setBatchId(e.target.value)} aria-describedby={`${id}-batch-hint`} />
            </div>
            <div className="rr-field">
              <label htmlFor={`${id}-note`} className="rr-field__label">
                Note <span className="rr-optional">(required to record as not created)</span>
              </label>
              <textarea id={`${id}-note`} className="rr-textarea" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <MutationError error={reconcile.error} />
            <div className="rr-form__actions">
              <Button type="submit" size="sm" icon={<Link2 size={14} aria-hidden="true" />} loading={reconcile.isPending && reconcile.variables?.action === 'link_batch'} disabled={!batchId.trim()}>
                Link batch
              </Button>
              {sub.state === 'needs_manual_reconciliation' && (
                <Button
                  size="sm"
                  icon={<Ban size={14} aria-hidden="true" />}
                  loading={reconcile.isPending && reconcile.variables?.action === 'record_not_created'}
                  disabled={note.trim().length < 10}
                  onClick={() => reconcile.mutate({ submissionId: sub.id, action: 'record_not_created', note: note.trim() })}
                >
                  Record as not created
                </Button>
              )}
            </div>
            <p className="rr-field__hint">Recording as not created is only accepted 31 days after approval, once PayPal&apos;s duplicate protection has passed.</p>
          </form>
        </details>
      )}
    </li>
  );
}

function CancellationItem({ can, caseId, canReconcile }: { can: CancellationView; caseId: string; canReconcile: boolean }) {
  const recheck = useRecheckCancellation(caseId);
  const { t } = usePayPalTarget();
  return (
    <li className="rr-action-record">
      <div className="rr-action-record__top">
        <CancellationStateBadge state={can.state} size="sm" />
        <span>
          Cancel <span className="rr-mono">{can.targetItem.reference}</span>
        </span>
      </div>
      <dl className="rr-facts rr-facts--compact">
        <Fact label="Approved">
          <DateTime value={can.approvedAt} />
        </Fact>
        <Fact label="Requests sent">
          <span className="rr-num">
            {can.sendCount} of {can.maxSends}
          </span>
        </Fact>
        {can.resolvedBy && <Fact label="Confirmed by">{t(can.resolvedBy === 'cancel_response' ? 'PayPal Sandbox cancel response and status check' : 'A status check from PayPal Sandbox')}</Fact>}
        {(can.lastErrorName || can.lastHttpStatus) && (
          <Fact label="Last response">
            <span className="rr-mono">
              {can.lastHttpStatus ? `HTTP ${can.lastHttpStatus}` : 'No response'} {can.lastErrorName ?? ''}
            </span>
          </Fact>
        )}
      </dl>
      {canReconcile && can.state === 'needs_manual_reconciliation' && (
        <div className="rr-form__actions">
          <Button size="sm" icon={<Search size={14} aria-hidden="true" />} loading={recheck.isPending} onClick={() => recheck.mutate(can.id)}>
            {t('Re-check status with PayPal Sandbox')}
          </Button>
        </div>
      )}
      <MutationError error={recheck.error} />
    </li>
  );
}

function DiscrepancyItem({ d, caseId, canResolve }: { d: DiscrepancyView; caseId: string; canResolve: boolean }) {
  const resolve = useResolveDiscrepancy(caseId);
  const [note, setNote] = useState('');
  const id = useId();
  const { t } = usePayPalTarget();
  return (
    <li className="rr-action-record">
      <div className="rr-action-record__top">
        {d.resolution ? (
          <Badge tone="neutral" icon={CircleCheck} size="sm" label="Resolved" />
        ) : (
          <Badge tone={d.severity === 'critical' ? 'critical' : 'warning'} icon={d.severity === 'critical' ? ShieldAlert : TriangleAlert} size="sm" label={d.severity === 'critical' ? 'Critical discrepancy' : 'Discrepancy'} />
        )}
        <DateTime value={d.recordedAt} />
      </div>
      <p>{d.description}</p>
      {(d.expected || d.actual) && (
        <p className="rr-field__hint">
          Expected <span className="rr-mono">{d.expected ?? '—'}</span>, {t('PayPal Sandbox reported')} <span className="rr-mono">{d.actual ?? '—'}</span>.
        </p>
      )}
      {d.resolution && (
        <p className="rr-field__hint">
          Resolved by {d.resolution.by.displayName}: {d.resolution.note}
        </p>
      )}
      {canResolve && !d.resolution && (
        <form
          className="rr-form rr-section-gap"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim().length >= 10) resolve.mutate({ discrepancyId: d.id, note: note.trim() });
          }}
        >
          <div className="rr-field">
            <label htmlFor={`${id}-note`} className="rr-field__label">
              Resolution note
            </label>
            <p id={`${id}-hint`} className="rr-field__hint">
              Explain what you checked (at least 10 characters). Resolving does not change any payment.
            </p>
            <textarea id={`${id}-note`} className="rr-textarea" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} aria-describedby={`${id}-hint`} />
          </div>
          <MutationError error={resolve.error} />
          <div className="rr-form__actions">
            <Button type="submit" size="sm" loading={resolve.isPending} disabled={note.trim().length < 10}>
              Mark as resolved
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

function PanelBody({ actions }: { actions: PaymentActionsResponse }) {
  const { data: session } = useSession();
  const { t } = usePayPalTarget();
  const role = session?.user.role;
  const canRetry = role === 'approver' || role === 'admin';
  const checkable = (a: PaymentAttemptView) => actions.enabled && actions.permissions.canCheckStatus && (a.provider?.mode === 'sandbox' || a.batch.providerMode === 'sandbox');
  const openDiscrepancies = actions.discrepancies.filter((d) => !d.resolution);

  return (
    <div className="rr-stack">
      <SandboxNotice text={actions.sandboxNotice} />
      {actions.blocks.length > 0 && (
        <div className="rr-notice rr-notice--warning" role="status">
          <Ban size={16} aria-hidden="true" />
          <div>
            <p className="rr-strong-link">No payment action can be proposed or approved right now</p>
            <ul className="rr-plain-list">
              {actions.blocks.map((b) => (
                <li key={b.code}>{b.message}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="rr-attempts">
        <AttemptCard attempt={actions.original} checkable={checkable(actions.original)} caseId={actions.case.id} />
        {actions.recoveries.map((r) => (
          <AttemptCard key={r.itemId} attempt={r} checkable={checkable(r)} caseId={actions.case.id} />
        ))}
      </div>

      {actions.openProposal && (
        <div className="rr-notice" role="status">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>
            {t(PROPOSAL_ACTION_INFO[actions.openProposal.action].label)} proposed by {actions.openProposal.proposedBy.displayName} is waiting for approval until{' '}
            <DateTime value={actions.openProposal.expiresAt} />. <Link to={`/approvals/${actions.openProposal.id}`}>Open the proposal</Link>.
          </span>
        </div>
      )}

      {actions.enabled && actions.permissions.canPropose && !actions.openProposal && (
        <>
          <ProposeForm key={actions.providerFingerprint + actions.case.version} actions={actions} />
          {!actions.reissue.available && actions.reissue.reasons.length > 0 && (
            <div>
              <p className="rr-field__label">Reissue is not available</p>
              <ul className="rr-plain-list rr-field__hint">
                {actions.reissue.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {!actions.cancel.available && actions.cancel.reasons.length > 0 && actions.recoveries.length > 0 && (
            <div>
              <p className="rr-field__label">Cancellation is not available</p>
              <ul className="rr-plain-list rr-field__hint">
                {actions.cancel.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {actions.enabled && !actions.permissions.canPropose && <p className="rr-muted">Your role can view payment actions but cannot propose them.</p>}
      {actions.limits && <LimitsSummary limits={actions.limits} />}

      {actions.submissions.length > 0 && (
        <section aria-label="Recovery submissions">
          <h3 className="rr-subheading">{t('Recovery submissions to PayPal Sandbox')}</h3>
          <ul role="list" className="rr-action-records">
            {actions.submissions.map((s) => (
              <SubmissionItem key={s.id} sub={s} caseId={actions.case.id} canRetry={canRetry} canReconcile={actions.permissions.canReconcile} />
            ))}
          </ul>
        </section>
      )}
      {actions.cancellations.length > 0 && (
        <section aria-label="Cancellations">
          <h3 className="rr-subheading">Cancellations</h3>
          <ul role="list" className="rr-action-records">
            {actions.cancellations.map((c) => (
              <CancellationItem key={c.id} can={c} caseId={actions.case.id} canReconcile={actions.permissions.canReconcile} />
            ))}
          </ul>
        </section>
      )}
      {actions.discrepancies.length > 0 && (
        <section aria-label="Provider discrepancies">
          <h3 className="rr-subheading">
            Provider discrepancies{openDiscrepancies.length > 0 ? ` (${openDiscrepancies.length} unresolved)` : ''}
          </h3>
          <ul role="list" className="rr-action-records">
            {actions.discrepancies.map((d) => (
              <DiscrepancyItem key={d.id} d={d} caseId={actions.case.id} canResolve={actions.permissions.canReconcile} />
            ))}
          </ul>
        </section>
      )}
      {actions.proposals.length > 0 && (
        <section aria-label="Proposal history">
          <h3 className="rr-subheading">Proposals</h3>
          <ul role="list" className="rr-action-records">
            {actions.proposals.map((p) => (
              <li key={p.id} className="rr-action-record">
                <div className="rr-action-record__top">
                  <ProposalStatusBadge status={p.status} size="sm" />
                  <Link to={`/approvals/${p.id}`}>{t(PROPOSAL_ACTION_INFO[p.action].label)}</Link>
                </div>
                <p className="rr-field__hint">
                  {formatMoneyValue(p.amount)} · proposed by {p.proposedBy.displayName} <DateTime value={p.proposedAt} />
                  {p.decidedBy && (
                    <>
                      {' '}
                      · decided by {p.decidedBy.displayName}
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function PaymentActionsPanel({ caseId }: { caseId: string }) {
  const { data, error, isPending, isError, refetch, isFetching } = usePaymentActions(caseId);
  const { t } = usePayPalTarget();
  return (
    <Panel
      title="Payment actions"
      description={t('Recovery actions in PayPal Sandbox only. Every action is proposed by one person and approved by a different person; AI never proposes or approves.')}
      actions={
        <ButtonLink to="/approvals" size="sm" variant="ghost" icon={<Send size={14} aria-hidden="true" />}>
          Approval centre
        </ButtonLink>
      }
    >
      {isPending && <LoadingState label="Loading payment actions" rows={3} />}
      {isError && <ErrorState title="Payment actions could not be loaded" error={error} onRetry={() => void refetch()} retrying={isFetching} />}
      {data && <PanelBody actions={data} />}
    </Panel>
  );
}
