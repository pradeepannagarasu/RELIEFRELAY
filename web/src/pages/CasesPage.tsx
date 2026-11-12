import { Inbox, Search, X } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CASE_SORT_FIELDS, type CaseListItem, type CaseSortField } from '@shared/api/contracts';
import { CASE_BASIS_INFO, CASE_STATE_INFO, NEXT_ACTION_CODES, NEXT_ACTION_LABELS } from '@shared/domain/cases';
import { describeOpeningReason } from '@shared/domain/findings';
import { PAYOUT_ITEM_STATUSES, PAYOUT_ITEM_STATUS_INFO } from '@shared/domain/paypal';
import { CASE_BASES, CASE_STATES } from '@shared/domain/types';
import { CaseBasisBadge, CaseStateBadge, ReportedStatusBadge } from '../components/status/StatusBadges';
import { Button } from '../components/ui/Button';
import { DateTime } from '../components/ui/DateTime';
import { PageHeader } from '../components/ui/PageHeader';
import { Pagination } from '../components/ui/Pagination';
import { Panel } from '../components/ui/Panel';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { useCaseList } from '../hooks/useCases';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { formatMoneyValue } from '../lib/format';

const FILTER_KEYS = ['q', 'status', 'source', 'state', 'nextAction', 'basis', 'batch', 'assignee', 'import', 'sort', 'order', 'page'] as const;
const PAGE_SIZE = 25;

const SORT_LABELS: Record<CaseSortField, string> = {
  updated: 'Last updated',
  opened: 'Date opened',
  due: 'Deadline',
  amount: 'Amount',
  reference: 'Case reference',
};

function SelectFilter({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  allLabel?: string;
}) {
  const id = useId();
  return (
    <div className="rr-field rr-field--inline">
      <label htmlFor={id} className="rr-field__label">
        {label}
      </label>
      <select id={id} className="rr-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {allLabel !== undefined && <option value="">{allLabel}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function CaseTable({ cases, asOf }: { cases: CaseListItem[]; asOf: Date }) {
  return (
    <div className="rr-table-scroll" role="region" aria-label="Payment cases table" tabIndex={0}>
      <table className="rr-table rr-table--cases">
        <caption className="rr-visually-hidden">Payment cases matching the current filters</caption>
        <thead>
          <tr>
            <th scope="col">Case</th>
            <th scope="col">Payment</th>
            <th scope="col">Reported status</th>
            <th scope="col">Case state</th>
            <th scope="col">Next action</th>
            <th scope="col" className="rr-table__num">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.id}>
              <th scope="row" className="rr-table__primary">
                <Link to={`/cases/${c.id}`} className="rr-strong-link rr-mono">
                  {c.reference}
                </Link>
                <span className="rr-table__secondary">{describeOpeningReason(c.openingReason)}</span>
                <span className="rr-table__secondary">
                  Opened <DateTime value={c.openedAt} format="date" />
                </span>
              </th>
              <td>
                <span className="rr-mono rr-nowrap">{c.payment.reference}</span>
                <span className="rr-table__secondary rr-nowrap">{c.payment.recipientReference}</span>
                <span className="rr-table__secondary rr-nowrap">{c.payment.batchReference}</span>
              </td>
              <td>{c.status ? <ReportedStatusBadge status={c.status.status} source={c.status.source} size="sm" /> : <span className="rr-muted">No status recorded</span>}</td>
              <td>
                <div className="rr-badge-row">
                  <CaseStateBadge state={c.state} size="sm" />
                  <CaseBasisBadge basis={c.basis} />
                </div>
                <span className="rr-table__secondary">{c.assignee ? c.assignee.displayName : 'Unassigned'}</span>
              </td>
              <td>
                {c.nextAction.label}
                {c.nextAction.dueAt && (
                  <span className={`rr-table__secondary ${Date.parse(c.nextAction.dueAt) - asOf.getTime() < 7 * 86_400_000 ? 'rr-needs-action' : ''}`}>
                    By <DateTime value={c.nextAction.dueAt} format="date" />
                  </span>
                )}
              </td>
              <td className="rr-table__num rr-num">{formatMoneyValue(c.payment.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CasesPage() {
  useDocumentTitle('Payment cases');
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const searchId = useId();

  const apiParams = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value) apiParams.set(key, value);
  }
  apiParams.set('pageSize', String(PAGE_SIZE));
  const { data, error, isPending, isError, refetch, isFetching } = useCaseList(apiParams.toString());

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next, { replace: true });
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    update({ q: search.trim() || null });
  };

  const activeFilters = FILTER_KEYS.filter((k) => !['sort', 'order', 'page'].includes(k) && params.get(k)).length;
  const page = Number(params.get('page') ?? '1') || 1;
  const sort = (params.get('sort') ?? 'updated') as CaseSortField;
  const importFilter = params.get('import');

  return (
    <div className="rr-page">
      <PageHeader
        title="Payment cases"
        description="Every undelivered or inconsistent payment, tracked as a case until it is resolved. Statuses show whether they come from the provider or an imported record."
      />

      <Panel title="Find cases" description={importFilter ? 'Showing cases with findings from one import.' : undefined}>
        <form className="rr-search" role="search" onSubmit={submitSearch}>
          <label htmlFor={searchId} className="rr-field__label">
            Search by case, payment, recipient or batch reference
          </label>
          <div className="rr-search__row">
            <input
              id={searchId}
              className="rr-input"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              maxLength={100}
              autoComplete="off"
            />
            <Button type="submit" icon={<Search size={16} aria-hidden="true" />}>
              Search
            </Button>
          </div>
        </form>
        <div className="rr-filter-grid">
          <SelectFilter
            label="Case state"
            value={params.get('state') ?? 'active'}
            onChange={(v) => update({ state: v === 'active' ? null : v })}
            options={[
              { value: 'active', label: 'All active cases' },
              { value: 'all', label: 'All cases, including closed' },
              ...CASE_STATES.map((s) => ({ value: s, label: CASE_STATE_INFO[s].label })),
            ]}
          />
          <SelectFilter
            label="Reported status"
            value={params.get('status') ?? ''}
            onChange={(v) => update({ status: v || null })}
            allLabel="Any status"
            options={PAYOUT_ITEM_STATUSES.map((s) => ({ value: s, label: PAYOUT_ITEM_STATUS_INFO[s].label }))}
          />
          <SelectFilter
            label="Status source"
            value={params.get('source') ?? ''}
            onChange={(v) => update({ source: v || null })}
            allLabel="Provider or imported"
            options={[
              { value: 'provider', label: 'Provider' },
              { value: 'imported', label: 'Imported record only' },
            ]}
          />
          <SelectFilter
            label="Case basis"
            value={params.get('basis') ?? ''}
            onChange={(v) => update({ basis: v || null })}
            allLabel="Any basis"
            options={CASE_BASES.map((b) => ({ value: b, label: CASE_BASIS_INFO[b].label }))}
          />
          <SelectFilter
            label="Next action"
            value={params.get('nextAction') ?? ''}
            onChange={(v) => update({ nextAction: v || null })}
            allLabel="Any next action"
            options={NEXT_ACTION_CODES.filter((c) => c !== 'none').map((c) => ({ value: c, label: NEXT_ACTION_LABELS[c] }))}
          />
          <SelectFilter
            label="Batch"
            value={params.get('batch') ?? ''}
            onChange={(v) => update({ batch: v || null })}
            allLabel="Any batch"
            options={(data?.batches ?? []).map((b) => ({ value: b.id, label: b.reference }))}
          />
          <SelectFilter
            label="Assignee"
            value={params.get('assignee') ?? ''}
            onChange={(v) => update({ assignee: v || null })}
            allLabel="Anyone"
            options={[
              { value: 'me', label: 'Assigned to me' },
              { value: 'unassigned', label: 'Unassigned' },
            ]}
          />
          <SelectFilter
            label="Sort by"
            value={sort}
            onChange={(v) => update({ sort: v === 'updated' ? null : v, order: v === 'due' ? 'asc' : null })}
            options={CASE_SORT_FIELDS.map((f) => ({ value: f, label: SORT_LABELS[f] }))}
          />
          <SelectFilter
            label="Order"
            value={params.get('order') ?? 'desc'}
            onChange={(v) => update({ order: v })}
            options={[
              { value: 'desc', label: sort === 'due' ? 'Latest first' : 'Newest or largest first' },
              { value: 'asc', label: sort === 'due' ? 'Soonest first' : 'Oldest or smallest first' },
            ]}
          />
        </div>
        {activeFilters > 0 && (
          <div className="rr-form__actions">
            <Button
              size="sm"
              variant="ghost"
              icon={<X size={14} aria-hidden="true" />}
              onClick={() => {
                setSearch('');
                setParams(new URLSearchParams(), { replace: true });
              }}
            >
              Clear filters
            </Button>
          </div>
        )}
      </Panel>

      <Panel title="Cases" flush className="rr-section-gap">
        {isPending && <LoadingState label="Loading cases" rows={5} />}
        {isError && (
          <div className="rr-panel__inset">
            <ErrorState title="Cases could not be loaded" error={error} onRetry={() => void refetch()} retrying={isFetching} />
          </div>
        )}
        {data && data.cases.length === 0 && (
          <div className="rr-panel__inset">
            <EmptyState icon={Inbox} title="No cases match these filters">
              {activeFilters > 0 ? 'Try clearing some filters.' : 'Cases are opened automatically from provider statuses and imported records.'}
            </EmptyState>
          </div>
        )}
        {data && data.cases.length > 0 && (
          <div aria-busy={isFetching || undefined}>
            <CaseTable cases={data.cases} asOf={new Date()} />
            <Pagination
              page={page}
              pages={Math.max(1, Math.ceil(data.total / data.pageSize))}
              total={data.total}
              pageSize={data.pageSize}
              noun="case"
              onChange={(p) => update({ page: p === 1 ? null : String(p) })}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}
