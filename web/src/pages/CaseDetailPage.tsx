import { ArrowLeft, FileSpreadsheet, FlaskConical, History, StickyNote, UserCheck, UserRound, Workflow } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CaseDetail } from '@shared/api/contracts';
import { describeOpeningReason, FINDING_INFO } from '@shared/domain/findings';
import { PAYOUT_ITEM_STATUS_INFO } from '@shared/domain/paypal';
import {
  CaseBasisBadge,
  CaseStateBadge,
  EventSourceLabel,
  FindingBadge,
  ImportedStatusBadge,
  ProviderModeBadge,
  ProviderStatusBadge,
} from '../components/status/StatusBadges';
import { InvestigationPanel } from '../components/investigation/InvestigationPanel';
import { PaymentActionsPanel } from '../components/payouts/PaymentActionsPanel';
import { Button } from '../components/ui/Button';
import { DateTime } from '../components/ui/DateTime';
import { PageHeader } from '../components/ui/PageHeader';
import { Panel } from '../components/ui/Panel';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { useAddNote, useAssignCase, useCase } from '../hooks/useCases';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { formatMoneyValue } from '../lib/format';
import { ApiError } from '../services/apiClient';

const NOTE_LIMIT = 2000;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rr-facts__item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function StatusPanels({ detail }: { detail: CaseDetail }) {
  const { provider, imported } = detail;
  return (
    <div className="rr-status-panels">
      <section className="rr-status-panel" aria-labelledby="provider-record-title">
        <h2 id="provider-record-title" className="rr-status-panel__title">
          <FlaskConical size={16} aria-hidden="true" />
          Provider record
        </h2>
        {provider ? (
          <>
            <ProviderStatusBadge status={provider.status} />
            <dl className="rr-facts rr-facts--stacked">
              <Fact label="Mode">
                <ProviderModeBadge mode={provider.mode} />
              </Fact>
              <Fact label="Last updated">
                <DateTime value={provider.statusUpdatedAt} />
              </Fact>
              {provider.errorCode && (
                <Fact label="Error code">
                  <span className="rr-mono">{provider.errorCode}</span>
                </Fact>
              )}
              {provider.providerTransactionId && (
                <Fact label="Transaction ID">
                  <span className="rr-mono">{provider.providerTransactionId}</span>
                </Fact>
              )}
            </dl>
          </>
        ) : (
          <p className="rr-status-panel__empty">
            No provider record. ReliefRelay has not submitted this payment, so its delivery is unconfirmed.
          </p>
        )}
      </section>

      <section className="rr-status-panel" aria-labelledby="imported-record-title">
        <h2 id="imported-record-title" className="rr-status-panel__title">
          <FileSpreadsheet size={16} aria-hidden="true" />
          Current imported record
        </h2>
        {imported ? (
          <>
            <ImportedStatusBadge status={imported.status} />
            <dl className="rr-facts rr-facts--stacked">
              <Fact label="Source">
                <Link to={`/import/${imported.importId}`}>{imported.fileName}</Link>, row {imported.rowNumber}
              </Fact>
              <Fact label="Status date">{imported.statusAt ? <DateTime value={imported.statusAt} format="date" /> : 'Not given'}</Fact>
              <Fact label="Recorded">
                <DateTime value={imported.recordedAt} />
              </Fact>
              {imported.errorCode && (
                <Fact label="Error code">
                  <span className="rr-mono">{imported.errorCode}</span>
                </Fact>
              )}
            </dl>
            <p className="rr-status-panel__note">Not confirmed by the provider.</p>
          </>
        ) : (
          <p className="rr-status-panel__empty">No imported status observations for this payment.</p>
        )}
      </section>

      <section className="rr-status-panel" aria-labelledby="case-workflow-title">
        <h2 id="case-workflow-title" className="rr-status-panel__title">
          <Workflow size={16} aria-hidden="true" />
          Case workflow
        </h2>
        <CaseStateBadge state={detail.case.state} />
        <dl className="rr-facts rr-facts--stacked">
          <Fact label="Basis">
            <CaseBasisBadge basis={detail.case.basis} />
          </Fact>
          <Fact label="Opened because">{describeOpeningReason(detail.case.openingReason)}</Fact>
          <Fact label="Assignee">{detail.case.assignee?.displayName ?? 'Unassigned'}</Fact>
          <Fact label="Opened">
            <DateTime value={detail.case.openedAt} />
          </Fact>
          <Fact label="Last updated">
            <DateTime value={detail.case.updatedAt} />
          </Fact>
        </dl>
        {detail.case.resolution && <p className="rr-status-panel__note">{detail.case.resolution.summary}</p>}
      </section>
    </div>
  );
}

function NextActionPanel({ detail }: { detail: CaseDetail }) {
  const assign = useAssignCase(detail.case.id);
  const conflict = assign.error instanceof ApiError && assign.error.status === 409;
  return (
    <Panel
      title="Next action"
      description="Derived from the case state, why it opened and the reported status. It describes the work, never whether a recipient should be paid."
    >
      <p className="rr-next-action">{detail.nextAction.label}</p>
      {detail.nextAction.dueAt && (
        <p className="rr-muted">
          Expected deadline: <DateTime value={detail.nextAction.dueAt} format="date" />
        </p>
      )}
      {assign.isError && (
        <p className="rr-inline-error" role="alert">
          {assign.error.message}
          {conflict && ' The latest details have been loaded.'}
        </p>
      )}
      {detail.permissions.canAssign && (
        <div className="rr-form__actions">
          <Button
            variant="primary"
            icon={<UserCheck size={16} aria-hidden="true" />}
            loading={assign.isPending}
            onClick={() => assign.mutate(detail.case.version)}
          >
            {detail.case.assignee ? 'Reassign to me' : 'Assign to me and start investigating'}
          </Button>
        </div>
      )}
    </Panel>
  );
}

function PaymentPanel({ detail }: { detail: CaseDetail }) {
  const { payment, batch } = detail;
  return (
    <Panel title="Payment" description="Synthetic demo record. The receiver is shown masked.">
      <dl className="rr-facts" id="payment-details">
        <Fact label="Payment reference">
          <span className="rr-mono">{payment.reference}</span>
        </Fact>
        <Fact label="Amount">
          <span className="rr-num">{formatMoneyValue(payment.amount)}</span>
        </Fact>
        <Fact label="Recipient reference">
          <span className="rr-mono">{payment.recipientReference}</span>
        </Fact>
        <Fact label="Receiver">
          {payment.recipientMasked} <span className="rr-muted">({payment.recipientType === 'EMAIL' ? 'email' : 'phone'})</span>
        </Fact>
        <Fact label="Batch">
          <Link to={`/cases?batch=${batch.id}&state=all`} className="rr-mono">
            {batch.reference}
          </Link>
          <span className="rr-muted"> · {batch.programme}</span>
        </Fact>
        <Fact label="Batch source">{batch.origin === 'csv_import' ? 'Imported from CSV, not submitted by ReliefRelay' : 'Submitted to the provider'}</Fact>
        {payment.recoveryOf && (
          <Fact label="Recovery of">
            <span className="rr-mono">{payment.recoveryOf.reference}</span>
          </Fact>
        )}
      </dl>
      {detail.recoveries.length > 0 && (
        <>
          <h3 className="rr-subheading">Recovery payments</h3>
          <ul className="rr-plain-list">
            {detail.recoveries.map((r) => (
              <li key={r.id}>
                <span className="rr-mono">{r.reference}</span> · {formatMoneyValue(r.amount)} ·{' '}
                {r.providerStatus ? PAYOUT_ITEM_STATUS_INFO[r.providerStatus].label : 'No provider status'}
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function FindingsPanel({ detail }: { detail: CaseDetail }) {
  return (
    <Panel title="Reconciliation findings" description="Deterministic rule results recorded when records were imported. They are facts to check, not conclusions.">
      {detail.findings.length === 0 ? (
        <p className="rr-muted">No findings. This case was opened from the provider status.</p>
      ) : (
        <ul className="rr-findings">
          {detail.findings.map((f) => (
            <li key={f.id} id={`finding-${f.id}`} className="rr-finding">
              <div className="rr-finding__top">
                <FindingBadge code={f.code} />
                <DateTime value={f.recordedAt} format="date" />
              </div>
              <p>{f.detail}</p>
              <p className="rr-finding__meta">
                {FINDING_INFO[f.code].description}
                {f.import && (
                  <>
                    {' '}
                    Source: <Link to={`/import/${f.import.id}`}>{f.import.fileName}</Link>, row {f.import.rowNumber}.
                  </>
                )}
                {f.relatedPayments.length > 0 && <> Related: {f.relatedPayments.map((p) => p.reference).join(', ')}.</>} Rule version{' '}
                {f.ruleVersion}.
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ObservationsPanel({ detail }: { detail: CaseDetail }) {
  if (detail.observations.length === 0) return null;
  return (
    <Panel title="Imported status history" description="Every status observation from imported files, newest first. Earlier observations are never overwritten." flush>
      <div className="rr-table-scroll" role="region" aria-label="Imported status history table" tabIndex={0}>
        <table className="rr-table rr-table--compact">
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Status date</th>
              <th scope="col">Source</th>
              <th scope="col">Recorded</th>
            </tr>
          </thead>
          <tbody>
            {detail.observations.map((o) => (
              <tr key={o.observationId} id={`observation-${o.observationId}`}>
                <td>
                  <ImportedStatusBadge status={o.status} size="sm" />
                  {o.isCurrent && <span className="rr-table__secondary">Current imported status</span>}
                  {o.errorCode && <span className="rr-table__secondary rr-mono">{o.errorCode}</span>}
                </td>
                <td>{o.statusAt ? <DateTime value={o.statusAt} format="date" /> : '—'}</td>
                <td>
                  <Link to={`/import/${o.importId}`}>{o.fileName}</Link>
                  <span className="rr-table__secondary">Row {o.rowNumber}</span>
                </td>
                <td>
                  <DateTime value={o.recordedAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function TimelinePanel({ detail }: { detail: CaseDetail }) {
  return (
    <Panel title="Timeline" description="Provider, import, system and operator events for this payment, oldest first.">
      {detail.timeline.length === 0 ? (
        <p className="rr-muted">No events recorded.</p>
      ) : (
        <ol role="list" className="rr-timeline">
          {detail.timeline.map((e) => (
            <li key={e.id} id={`event-${e.id}`} className="rr-timeline__item">
              <p className="rr-timeline__summary">{e.summary}</p>
              <p className="rr-activity__meta">
                <DateTime value={e.occurredAt} />
                <EventSourceLabel source={e.source} />
                {e.actorName && <span>{e.actorName}</span>}
                {e.providerEventType && <span className="rr-mono">{e.providerEventType}</span>}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function SourceRowPanel({ detail }: { detail: CaseDetail }) {
  const row = detail.sourceRow;
  if (!row) return null;
  return (
    <Panel
      title="Source row"
      description={
        <>
          The row this payment was created from: <Link to={`/import/${row.importId}`}>{row.fileName}</Link>, row {row.rowNumber}, exactly as uploaded.
        </>
      }
    >
      <dl className="rr-facts rr-facts--compact">
        {row.headers.map((header, index) => (
          <Fact key={index} label={header}>
            <span className="rr-cell-raw">{row.values[index] || '—'}</span>
          </Fact>
        ))}
      </dl>
    </Panel>
  );
}

function NotesPanel({ detail }: { detail: CaseDetail }) {
  const [body, setBody] = useState('');
  const add = useAddNote(detail.case.id);
  const id = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    add.mutate(body, { onSuccess: () => setBody('') });
  };
  return (
    <Panel title="Notes" description="Investigation notes are permanent and cannot be edited or deleted.">
      {detail.notes.length === 0 ? (
        <p className="rr-muted">No notes yet.</p>
      ) : (
        <ol role="list" className="rr-notes">
          {detail.notes.map((n) => (
            <li key={n.id} className="rr-note">
              <p className="rr-note__body">{n.body}</p>
              <p className="rr-activity__meta">
                <span className="rr-source">
                  <UserRound size={12} aria-hidden="true" />
                  Operator note
                </span>
                <span>{n.author.displayName}</span>
                <DateTime value={n.createdAt} />
              </p>
            </li>
          ))}
        </ol>
      )}
      {detail.permissions.canAddNote && (
        <form className="rr-form rr-note-form" onSubmit={submit} noValidate>
          <div className="rr-field">
            <label htmlFor={id} className="rr-field__label">
              Add a note
            </label>
            <p id={`${id}-hint`} className="rr-field__hint">
              Refer to recipients by their programme reference. Do not include email addresses, phone numbers, names or medical details.
            </p>
            <textarea
              id={id}
              className="rr-textarea"
              rows={3}
              maxLength={NOTE_LIMIT}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              aria-describedby={`${id}-hint ${id}-count${add.isError ? ` ${id}-error` : ''}`}
              aria-invalid={add.isError || undefined}
            />
            <p id={`${id}-count`} className="rr-field__hint rr-num">
              {body.length} of {NOTE_LIMIT} characters
            </p>
          </div>
          {add.isError && (
            <p id={`${id}-error`} className="rr-inline-error" role="alert">
              {add.error.message}
            </p>
          )}
          <div className="rr-form__actions">
            <Button type="submit" icon={<StickyNote size={16} aria-hidden="true" />} loading={add.isPending} disabled={!body.trim()}>
              Add note
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}

function HistoryPanel({ detail }: { detail: CaseDetail }) {
  return (
    <Panel title="Audit history" description="Entries from the tamper-evident audit log for this case, including refused actions.">
      {detail.history.length === 0 ? (
        <p className="rr-muted">No audit entries.</p>
      ) : (
        <ol role="list" className="rr-history">
          {detail.history.map((h) => (
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
  );
}

export function CaseDetailPage() {
  const { id = '' } = useParams();
  const { data, error, isPending, isError, refetch, isFetching } = useCase(id);
  useDocumentTitle(data ? `Case ${data.case.reference}` : 'Case');

  return (
    <div className="rr-page">
      <PageHeader
        eyebrow={
          <Link to="/cases" className="rr-back-link">
            <ArrowLeft size={14} aria-hidden="true" />
            All cases
          </Link>
        }
        title={data ? `Case ${data.case.reference}` : 'Case'}
        description={data ? `${describeOpeningReason(data.case.openingReason)} · payment ${data.payment.reference}` : undefined}
        actions={
          data ? (
            <div className="rr-badge-row">
              <CaseStateBadge state={data.case.state} />
              <CaseBasisBadge basis={data.case.basis} size="md" />
            </div>
          ) : undefined
        }
      />
      {isPending && <LoadingState label="Loading case" rows={5} />}
      {isError &&
        (error instanceof ApiError && error.status === 404 ? (
          <EmptyState icon={History} title="Case not found">
            It may belong to another organisation or the link may be wrong. <Link to="/cases">Back to all cases</Link>.
          </EmptyState>
        ) : (
          <ErrorState title="This case could not be loaded" error={error} onRetry={() => void refetch()} retrying={isFetching} />
        ))}
      {data && (
        <div className="rr-stack">
          <StatusPanels detail={data} />
          <div className="rr-case-grid">
            <div className="rr-stack">
              <NextActionPanel detail={data} />
              <PaymentActionsPanel caseId={data.case.id} />
              <InvestigationPanel caseId={data.case.id} caseVersion={data.case.version} />
              <FindingsPanel detail={data} />
              <ObservationsPanel detail={data} />
              <TimelinePanel detail={data} />
            </div>
            <div className="rr-stack">
              <PaymentPanel detail={data} />
              <NotesPanel detail={data} />
              <SourceRowPanel detail={data} />
              <HistoryPanel detail={data} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
