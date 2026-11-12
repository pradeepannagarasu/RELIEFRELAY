import { CircleCheck, CircleX, History } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { Badge } from '../components/ui/Badge';
import { DateTime } from '../components/ui/DateTime';
import { PageHeader } from '../components/ui/PageHeader';
import { Pagination } from '../components/ui/Pagination';
import { Panel } from '../components/ui/Panel';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAuditHistory } from '../hooks/usePayouts';
import '../styles/payouts.css';

const PAGE_SIZE = 50;

function StateDiff({ previous, next }: { previous: unknown; next: unknown }) {
  if (previous == null && next == null) return null;
  return (
    <details className="rr-disclosure rr-audit__state">
      <summary>State change</summary>
      {previous != null && (
        <>
          <p className="rr-field__label">Previous</p>
          <pre className="rr-audit__json">{JSON.stringify(previous, null, 2)}</pre>
        </>
      )}
      {next != null && (
        <>
          <p className="rr-field__label">New</p>
          <pre className="rr-audit__json">{JSON.stringify(next, null, 2)}</pre>
        </>
      )}
    </details>
  );
}

export function AuditPage() {
  useDocumentTitle('Audit history');
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const action = params.get('action') ?? '';
  const outcome = params.get('outcome') ?? '';
  const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), ...(action ? { action } : {}), ...(outcome ? { outcome } : {}) }).toString();
  const { data, error, isPending, isError, refetch, isFetching } = useAuditHistory(query);

  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next);
  };

  return (
    <div className="rr-page">
      <PageHeader
        title="Audit history"
        description="Every recorded action, including refused attempts, newest first. Entries are append-only and hash-chained, so later changes are detectable (tamper-evident, not tamper-proof)."
      />
      <Panel
        title="Entries"
        flush
        actions={
          <div className="rr-filter-bar">
            <div className="rr-field rr-field--inline">
              <label htmlFor="audit-action" className="rr-field__label">
                Action
              </label>
              <select id="audit-action" className="rr-select" value={action} onChange={(e) => update({ action: e.target.value })}>
                <option value="">All actions</option>
                {data?.actions.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <div className="rr-field rr-field--inline">
              <label htmlFor="audit-outcome" className="rr-field__label">
                Outcome
              </label>
              <select id="audit-outcome" className="rr-select" value={outcome} onChange={(e) => update({ outcome: e.target.value })}>
                <option value="">All outcomes</option>
                <option value="succeeded">Succeeded</option>
                <option value="rejected">Refused</option>
              </select>
            </div>
          </div>
        }
        footer={data && data.total > 0 ? <Pagination page={data.page} pages={Math.ceil(data.total / data.pageSize)} total={data.total} pageSize={data.pageSize} noun="entry" onChange={(p) => update({ page: String(p) })} /> : undefined}
      >
        {isPending && <LoadingState label="Loading audit history" rows={6} />}
        {isError && (
          <div className="rr-panel__inset">
            <ErrorState title="Audit history could not be loaded" error={error} onRetry={() => void refetch()} retrying={isFetching} />
          </div>
        )}
        {data && data.entries.length === 0 && (
          <div className="rr-panel__inset">
            <EmptyState icon={History} title="No matching entries" />
          </div>
        )}
        {data && data.entries.length > 0 && (
          <div className="rr-table-scroll" role="region" aria-label="Audit entries table" tabIndex={0}>
            <table className="rr-table rr-table--compact rr-audit">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Recorded</th>
                  <th scope="col">Action</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.seq}>
                    <td className="rr-num">{e.seq}</td>
                    <td className="rr-nowrap">
                      <DateTime value={e.recordedAt} />
                    </td>
                    <td>
                      <span className="rr-mono">{e.action}</span>
                      <span className="rr-table__secondary">
                        {e.entityType}
                        {e.entityId ? <span className="rr-mono"> {e.entityId}</span> : null}
                      </span>
                      {e.reason && <span className="rr-table__secondary">{e.reason}</span>}
                      <StateDiff previous={e.previousState} next={e.newState} />
                    </td>
                    <td>{e.actor ? `${e.actor.displayName} (${e.actor.role})` : 'ReliefRelay system'}</td>
                    <td>
                      {e.outcome === 'rejected' ? (
                        <Badge tone="critical" icon={CircleX} size="sm" label="Refused" />
                      ) : (
                        <Badge tone="success" icon={CircleCheck} size="sm" label="Succeeded" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
