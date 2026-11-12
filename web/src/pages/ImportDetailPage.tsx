import { ArrowLeft, ArrowRight, CircleCheck, FileX2, Info, ListChecks, Trash2 } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import type { ImportDetail } from '@shared/api/contracts';
import {
  IMPORT_FIELD_INFO,
  IMPORT_FIELDS,
  ROW_ISSUE_CODES,
  ROW_ISSUE_LABELS,
  ROW_OUTCOME_INFO,
  type ColumnMapping,
  type ImportField,
  type RowIssueCode,
  type RowOutcome,
} from '@shared/domain/imports';
import { PAYOUT_ITEM_STATUS_INFO } from '@shared/domain/paypal';
import { ImportStatusBadge, RowOutcomeBadge } from '../components/status/StatusBadges';
import { Button, ButtonLink } from '../components/ui/Button';
import { DateTime } from '../components/ui/DateTime';
import { PageHeader } from '../components/ui/PageHeader';
import { Pagination } from '../components/ui/Pagination';
import { Panel } from '../components/ui/Panel';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useApplyMapping, useCommitImport, useDiscardImport, useImport, useImportRows, type RowFilter } from '../hooks/useImports';
import { useSession } from '../hooks/useSession';
import { formatCount, formatMoneyTotals, formatMoneyValue, plural } from '../lib/format';
import { ApiError } from '../services/apiClient';

const REVIEW_OUTCOMES: RowOutcome[] = ['new_payment', 'status_update', 'unchanged', 'rejected'];

function MappingPanel({ detail, canEdit }: { detail: ImportDetail; canEdit: boolean }) {
  const [mapping, setMapping] = useState<ColumnMapping>(detail.mapping ?? detail.suggestedMapping);
  const apply = useApplyMapping(detail.id);
  const idPrefix = useId();
  const missing = IMPORT_FIELDS.filter((field) => IMPORT_FIELD_INFO[field].required && mapping[field] === undefined);

  const setField = (field: ImportField, value: string) => {
    setMapping((current) => {
      const next = { ...current };
      if (value === '') delete next[field];
      else next[field] = Number(value);
      return next;
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    apply.mutate(mapping);
  };

  return (
    <Panel
      title={detail.status === 'validated' ? 'Column mapping' : 'Map your columns'}
      description="Choose which column in your file holds each field. Suggestions are based on the headings; check them before validating."
    >
      <form onSubmit={submit} noValidate>
        <div className="rr-mapping-grid">
          {IMPORT_FIELDS.map((field) => {
            const info = IMPORT_FIELD_INFO[field];
            const id = `${idPrefix}-${field}`;
            const value = mapping[field];
            return (
              <div key={field} className="rr-field">
                <label htmlFor={id} className="rr-field__label">
                  {info.label}
                  {info.required ? <span className="rr-required"> (required)</span> : <span className="rr-optional"> (optional)</span>}
                </label>
                <select
                  id={id}
                  className="rr-select"
                  value={value === undefined ? '' : String(value)}
                  onChange={(event) => setField(field, event.target.value)}
                  disabled={!canEdit}
                  aria-describedby={`${id}-hint`}
                  aria-invalid={info.required && value === undefined ? true : undefined}
                >
                  <option value="">Not in this file</option>
                  {detail.headers.map((header, index) => (
                    <option key={index} value={index}>
                      {header}
                    </option>
                  ))}
                </select>
                <p id={`${id}-hint`} className="rr-field__hint">
                  {info.description}
                </p>
              </div>
            );
          })}
        </div>

        <h3 className="rr-subheading">First rows as uploaded</h3>
        <div className="rr-table-scroll rr-table-scroll--boxed" role="region" aria-label="First rows as uploaded" tabIndex={0}>
          <table className="rr-table rr-table--compact">
            <thead>
              <tr>
                <th scope="col">Row</th>
                {detail.headers.map((header, index) => (
                  <th key={index} scope="col">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {detail.previewRows.map((row) => (
                <tr key={row.rowNumber}>
                  <th scope="row" className="rr-num">
                    {row.rowNumber}
                  </th>
                  {detail.headers.map((_, index) => (
                    <td key={index} className="rr-cell-raw">
                      {row.values[index] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {missing.length > 0 && (
          <p className="rr-inline-error" role="status">
            Map the required fields before validating: {missing.map((f) => IMPORT_FIELD_INFO[f].label).join(', ')}.
          </p>
        )}
        {apply.isError && (
          <p className="rr-inline-error" role="alert">
            {apply.error.message}
          </p>
        )}
        {canEdit && (
          <div className="rr-form__actions">
            <Button type="submit" variant="primary" icon={<ListChecks size={16} aria-hidden="true" />} loading={apply.isPending} disabled={missing.length > 0}>
              {detail.status === 'validated' ? 'Re-validate with this mapping' : 'Validate rows'}
            </Button>
          </div>
        )}
      </form>
    </Panel>
  );
}

function SummaryPanel({ detail }: { detail: ImportDetail }) {
  const summary = detail.summary;
  if (!summary) return null;
  const issues = Object.entries(summary.issueCounts) as [RowIssueCode, number][];
  const committed = detail.status === 'committed';
  return (
    <Panel
      title="Validation results"
      description={
        <>
          {plural(summary.dataRows, 'data row')} checked
          {detail.validatedAt && (
            <>
              {' '}
              at <DateTime value={detail.validatedAt} />
            </>
          )}
          {committed ? '. These are the results that were committed.' : '. Nothing has been recorded yet.'}
        </>
      }
    >
      <dl className="rr-summary-grid">
        {REVIEW_OUTCOMES.map((outcome) => (
          <div key={outcome} className="rr-summary-grid__item">
            <dt>
              <RowOutcomeBadge outcome={outcome} />
            </dt>
            <dd className="rr-num">{formatCount(summary.outcomes[outcome])}</dd>
            {!committed && <dd className="rr-summary-grid__desc">{ROW_OUTCOME_INFO[outcome].description}</dd>}
          </div>
        ))}
      </dl>
      <ul className="rr-plain-list rr-summary-notes">
        {summary.newBatchReferences.length > 0 && (
          <li>
            New batches: <span className="rr-mono">{summary.newBatchReferences.join(', ')}</span>
          </li>
        )}
        {summary.outcomes.new_payment > 0 && <li>Value of new payment records: {formatMoneyTotals(summary.newPaymentValue)}</li>}
        <li>{plural(summary.rowsWithWarnings, 'importable row')} with warnings</li>
        <li>
          {plural(summary.rowsRaisingFindings, 'row')} {committed ? 'raised' : 'will raise'} a finding that opens a case or is added to an active case
        </li>
      </ul>
      {issues.length > 0 && (
        <>
          <h3 className="rr-subheading">Issues found</h3>
          <ul className="rr-issue-counts">
            {issues.map(([code, count]) => (
              <li key={code}>
                <span>{ROW_ISSUE_LABELS[code]}</span>
                <span className="rr-num rr-muted">{plural(count, 'row')}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function RowsPanel({ detail }: { detail: ImportDetail }) {
  const [filter, setFilter] = useState<RowFilter>({ page: 1 });
  const { data, error, isPending, isError, refetch, isFetching } = useImportRows(detail.id, detail.validationVersion, filter);
  const idPrefix = useId();
  const issueCodes = ROW_ISSUE_CODES.filter((code) => (detail.summary?.issueCounts[code] ?? 0) > 0);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Panel title="Review rows" description="Every row with its outcome and any issues. Receivers are shown masked." flush>
      <div className="rr-filter-bar">
        <div className="rr-field rr-field--inline">
          <label htmlFor={`${idPrefix}-outcome`} className="rr-field__label">
            Outcome
          </label>
          <select
            id={`${idPrefix}-outcome`}
            className="rr-select"
            value={filter.outcome ?? ''}
            onChange={(e) => setFilter({ ...filter, outcome: (e.target.value || undefined) as RowOutcome | undefined, page: 1 })}
          >
            <option value="">All outcomes</option>
            {REVIEW_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {ROW_OUTCOME_INFO[o].label}
              </option>
            ))}
          </select>
        </div>
        <div className="rr-field rr-field--inline">
          <label htmlFor={`${idPrefix}-issue`} className="rr-field__label">
            Issue
          </label>
          <select
            id={`${idPrefix}-issue`}
            className="rr-select"
            value={filter.issue ?? ''}
            onChange={(e) => setFilter({ ...filter, issue: (e.target.value || undefined) as RowIssueCode | undefined, page: 1 })}
          >
            <option value="">Any or none</option>
            {issueCodes.map((code) => (
              <option key={code} value={code}>
                {ROW_ISSUE_LABELS[code]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isPending && <LoadingState label="Loading rows" rows={4} />}
      {isError && (
        <div className="rr-panel__inset">
          <ErrorState title="Rows could not be loaded" error={error} onRetry={() => void refetch()} retrying={isFetching} />
        </div>
      )}
      {data && data.rows.length === 0 && (
        <div className="rr-panel__inset">
          <EmptyState icon={Info} title="No rows match these filters" />
        </div>
      )}
      {data && data.rows.length > 0 && (
        <>
          <div className="rr-table-scroll" role="region" aria-label="Validated rows" tabIndex={0} aria-busy={isFetching || undefined}>
            <table className="rr-table rr-table--rows">
              <caption className="rr-visually-hidden">Validated rows, in file order</caption>
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Payment</th>
                  <th scope="col" className="rr-table__num">
                    Amount
                  </th>
                  <th scope="col">Recorded status</th>
                  <th scope="col">Issues</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.rowNumber}>
                    <th scope="row" className="rr-num">
                      {row.rowNumber}
                    </th>
                    <td>
                      <RowOutcomeBadge outcome={row.outcome} />
                    </td>
                    <td>
                      {row.normalised ? (
                        <>
                          <span className="rr-mono">{row.normalised.paymentReference}</span>
                          <span className="rr-table__secondary">
                            {row.normalised.recipientReference} · {row.normalised.receiverMasked}
                          </span>
                        </>
                      ) : (
                        <span className="rr-mono rr-muted">{row.values.slice(0, 2).join(' · ') || 'Empty'}</span>
                      )}
                    </td>
                    <td className="rr-table__num rr-num">{row.normalised ? formatMoneyValue(row.normalised.amount) : '—'}</td>
                    <td>
                      {row.normalised?.recordedStatus ? (
                        <span className="rr-mono" title={PAYOUT_ITEM_STATUS_INFO[row.normalised.recordedStatus].description}>
                          {row.normalised.recordedStatus}
                        </span>
                      ) : (
                        '—'
                      )}
                      {row.normalised?.statusAt && (
                        <span className="rr-table__secondary">
                          <DateTime value={row.normalised.statusAt} format="date" />
                        </span>
                      )}
                    </td>
                    <td>
                      {row.issues.length === 0 ? (
                        <span className="rr-muted">None</span>
                      ) : (
                        <ul className="rr-row-issues">
                          {row.issues.map((issue, index) => (
                            <li key={index} className={`rr-row-issue rr-row-issue--${issue.severity}`}>
                              <strong>{issue.severity === 'error' ? 'Error' : issue.severity === 'warning' ? 'Warning' : 'Note'}:</strong>{' '}
                              {issue.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={data.page}
            pages={pages}
            total={data.total}
            pageSize={data.pageSize}
            noun="row"
            onChange={(page) => setFilter({ ...filter, page })}
          />
        </>
      )}
    </Panel>
  );
}

function CommitPanel({ detail, onStale }: { detail: ImportDetail; onStale: (message: string) => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const checkboxId = useId();
  const commit = useCommitImport(detail.id);
  const discard = useDiscardImport(detail.id);
  const summary = detail.summary!;
  const importable = summary.outcomes.new_payment + summary.outcomes.status_update;

  const run = () =>
    commit.mutate(detail.validationVersion, {
      onError: (error) => {
        if (error instanceof ApiError && error.status === 409) {
          setConfirmed(false);
          onStale(error.message);
        }
      },
    });

  return (
    <Panel title="Commit import" description="Committing is final. Committed records cannot be edited or deleted; later files add new observations instead.">
      <ul className="rr-plain-list rr-commit-list">
        <li>{plural(summary.outcomes.new_payment, 'new payment record')} will be added.</li>
        <li>{plural(summary.outcomes.status_update, 'status observation')} will be added to existing payments without overwriting earlier history.</li>
        <li>{plural(summary.outcomes.rejected, 'rejected row')} will not be imported.</li>
        <li>No money moves. ReliefRelay does not submit anything to PayPal when importing.</li>
      </ul>
      <div className="rr-checkbox">
        <input id={checkboxId} type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <label htmlFor={checkboxId}>I have reviewed the validation results, including the rejected rows.</label>
      </div>
      {commit.isError && !(commit.error instanceof ApiError && commit.error.status === 409) && (
        <p className="rr-inline-error" role="alert">
          {commit.error.message}
        </p>
      )}
      {discard.isError && (
        <p className="rr-inline-error" role="alert">
          {discard.error.message}
        </p>
      )}
      <div className="rr-form__actions">
        <Button
          variant="primary"
          icon={<CircleCheck size={16} aria-hidden="true" />}
          disabled={!confirmed || (importable === 0 && summary.rowsRaisingFindings === 0)}
          loading={commit.isPending}
          onClick={run}
        >
          Commit import
        </Button>
        <Button variant="ghost" icon={<Trash2 size={16} aria-hidden="true" />} loading={discard.isPending} onClick={() => discard.mutate()}>
          Discard without importing
        </Button>
      </div>
      {importable === 0 && summary.rowsRaisingFindings === 0 && (
        <p className="rr-field__hint">There is nothing to import: every row is rejected or already recorded.</p>
      )}
    </Panel>
  );
}

function ResultPanel({ detail }: { detail: ImportDetail }) {
  const result = detail.result!;
  return (
    <Panel
      title="Import committed"
      description={
        <>
          Committed {detail.committedAt && <DateTime value={detail.committedAt} />}
          {detail.committedBy && ` by ${detail.committedBy.displayName}`}.
        </>
      }
    >
      <dl className="rr-summary-grid">
        <div className="rr-summary-grid__item">
          <dt>New payments</dt>
          <dd className="rr-num">{formatCount(result.newPayments)}</dd>
        </div>
        <div className="rr-summary-grid__item">
          <dt>Status observations</dt>
          <dd className="rr-num">{formatCount(result.statusObservations)}</dd>
        </div>
        <div className="rr-summary-grid__item">
          <dt>Findings recorded</dt>
          <dd className="rr-num">{formatCount(result.findingsRecorded)}</dd>
        </div>
        <div className="rr-summary-grid__item">
          <dt>Rows rejected</dt>
          <dd className="rr-num">{formatCount(result.rejected)}</dd>
        </div>
      </dl>
      {result.casesOpened.length > 0 && (
        <>
          <h3 className="rr-subheading">Cases opened ({formatCount(result.casesOpened.length)})</h3>
          <ul className="rr-link-list">
            {result.casesOpened.map((c) => (
              <li key={c.id}>
                <Link to={`/cases/${c.id}`}>{c.reference}</Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {result.casesUpdated.length > 0 && (
        <>
          <h3 className="rr-subheading">Existing cases with new findings ({formatCount(result.casesUpdated.length)})</h3>
          <ul className="rr-link-list">
            {result.casesUpdated.map((c) => (
              <li key={c.id}>
                <Link to={`/cases/${c.id}`}>{c.reference}</Link>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="rr-form__actions">
        <ButtonLink to={`/cases?import=${detail.id}&state=all`} variant="primary" icon={<ArrowRight size={16} aria-hidden="true" />} iconPosition="end">
          View cases from this import
        </ButtonLink>
      </div>
    </Panel>
  );
}

export function ImportDetailPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const alreadyUploaded = (location.state as { alreadyUploaded?: boolean } | null)?.alreadyUploaded === true;
  const { data, error, isPending, isError, refetch, isFetching } = useImport(id);
  const { data: session } = useSession();
  const [staleMessage, setStaleMessage] = useState<string | null>(null);
  useDocumentTitle(data ? `Import ${data.fileName}` : 'Import');
  const canEdit = session ? session.user.role === 'operator' || session.user.role === 'admin' : true;

  useEffect(() => {
    if (staleMessage) void refetch();
  }, [staleMessage, refetch]);

  return (
    <div className="rr-page">
      <PageHeader
        eyebrow={
          <Link to="/import" className="rr-back-link">
            <ArrowLeft size={14} aria-hidden="true" />
            All imports
          </Link>
        }
        title={data ? data.fileName : 'Import'}
        description={
          data ? (
            <>
              {plural(data.rowCount, 'data row')} · uploaded <DateTime value={data.uploadedAt} /> by {data.uploadedBy.displayName}
              {data.isSynthetic ? ' · synthetic demo data' : ''}
            </>
          ) : undefined
        }
        actions={data ? <ImportStatusBadge status={data.status} size="md" /> : undefined}
      />

      {isPending && <LoadingState label="Loading import" rows={4} />}
      {isError && <ErrorState title="This import could not be loaded" error={error} onRetry={() => void refetch()} retrying={isFetching} />}

      {data && (
        <div className="rr-stack">
          {alreadyUploaded && (
            <p className="rr-notice" role="status">
              <Info size={16} aria-hidden="true" />
              This exact file was uploaded before, so nothing new was stored. You are viewing the earlier upload.
            </p>
          )}
          {staleMessage && data.status === 'validated' && (
            <p className="rr-notice rr-notice--warning" role="alert">
              <Info size={16} aria-hidden="true" />
              {staleMessage}
            </p>
          )}
          {data.status === 'discarded' && (
            <EmptyState icon={FileX2} title="This import was discarded">
              Nothing from this file was recorded. Upload the file again to start over.
            </EmptyState>
          )}
          {data.status === 'draft' && <MappingPanel detail={data} canEdit={canEdit} />}
          {data.status === 'committed' && <ResultPanel detail={data} />}
          {data.status !== 'draft' && data.status !== 'discarded' && data.summary && <SummaryPanel detail={data} />}
          {data.status === 'validated' && data.summary && canEdit && (
            <CommitPanel key={`commit-${data.validationVersion}`} detail={data} onStale={setStaleMessage} />
          )}
          {data.validationVersion > 0 && data.status !== 'discarded' && <RowsPanel key={`rows-${data.validationVersion}`} detail={data} />}
          {data.status === 'validated' && <MappingPanel key={`mapping-${data.validationVersion}`} detail={data} canEdit={canEdit} />}
        </div>
      )}
    </div>
  );
}
