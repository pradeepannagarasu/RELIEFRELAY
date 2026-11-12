import { BookOpen, Calculator, Cpu, FileSpreadsheet, FlaskConical, GitCompareArrows, type LucideIcon } from 'lucide-react';
import type { EvidenceItemView, EvidenceSourceRef } from '@shared/api/contracts';
import type { EvidenceOrigin, EvidenceValue } from '@shared/domain/investigation';

export const ORIGIN_VISUAL: Record<EvidenceOrigin, { label: string; icon: LucideIcon }> = {
  provider_simulation: { label: 'Simulated provider record', icon: FlaskConical },
  provider_sandbox: { label: 'PayPal Sandbox record', icon: FlaskConical },
  imported: { label: 'Imported record', icon: FileSpreadsheet },
  reconciliation_rule: { label: 'Reconciliation rule', icon: GitCompareArrows },
  reliefrelay_record: { label: 'ReliefRelay record', icon: Cpu },
  reference_rule: { label: 'Reference rule', icon: BookOpen },
  derived: { label: 'Calculated by ReliefRelay', icon: Calculator },
};

const FIELD_LABELS: Record<string, string> = {
  caseReference: 'Case reference',
  paymentReference: 'Payment reference',
  batchReference: 'Batch reference',
  recoveryOfPaymentReference: 'Recovery of',
  receiverType: 'Receiver type',
  providerItemId: 'Provider item ID',
  providerTransactionId: 'Provider transaction ID',
  claimedProviderItemId: 'Provider item ID in file',
  claimedProviderTransactionId: 'Provider transaction ID in file',
  statusUpdatedAt: 'Status updated',
  errorCodeWithheld: 'Error code withheld',
  isCurrent: 'Current imported status',
  providerEventType: 'Provider event',
  relatedPaymentReferences: 'Related payments',
};

export function fieldLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const words = field.replace(/([A-Z])/g, ' $1').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatValue(value: EvidenceValue): string {
  if (value === null) return 'Not recorded';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'None';
  return String(value);
}

/** Where on the case page the current version of a record is shown. */
function anchorFor(source: EvidenceSourceRef | null): string | null {
  if (!source) return null;
  switch (source.type) {
    case 'provider_record':
      return 'provider-record-title';
    case 'observation':
      return `observation-${source.id}`;
    case 'finding':
      return `finding-${source.id}`;
    case 'event':
      return `event-${source.id}`;
    case 'case':
      return 'case-workflow-title';
    case 'payment':
    case 'batch':
      return 'payment-details';
  }
}

export function OriginTag({ origin }: { origin: EvidenceOrigin }) {
  const { label, icon: Icon } = ORIGIN_VISUAL[origin];
  return (
    <span className={`rr-origin rr-origin--${origin}`}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}

export function EvidenceFields({ item, highlight = [] }: { item: EvidenceItemView; highlight?: string[] }) {
  return (
    <dl className="rr-evidence-fields">
      {Object.entries(item.fields).map(([field, value]) => (
        <div key={field} className={highlight.includes(field) ? 'rr-evidence-fields__row rr-evidence-fields__row--cited' : 'rr-evidence-fields__row'}>
          <dt>
            {fieldLabel(field)}
            {highlight.includes(field) && <span className="rr-visually-hidden"> (cited)</span>}
          </dt>
          <dd className={typeof value === 'string' && value.length > 60 ? undefined : 'rr-mono'}>{formatValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** An inspectable reference to one evidence item from the snapshot the model received. */
export function EvidenceReference({ item, id, cited = [] }: { item: EvidenceItemView | undefined; id: string; cited?: string[] }) {
  if (!item) return <span className="rr-evidence-ref rr-evidence-ref--missing">{id} (not in snapshot)</span>;
  const anchor = anchorFor(item.source);
  return (
    <details className="rr-evidence-ref">
      <summary>
        <span className="rr-mono">{item.id}</span>
        <OriginTag origin={item.origin} />
      </summary>
      <div className="rr-evidence-ref__body">
        <EvidenceFields item={item} highlight={cited} />
        {anchor && (
          <p className="rr-evidence-ref__link">
            <a href={`#${anchor}`}>Show the current record on this page</a>
          </p>
        )}
      </div>
    </details>
  );
}

export function EvidenceList({ ids, evidence, cited = {} }: { ids: string[]; evidence: Map<string, EvidenceItemView>; cited?: Record<string, string[]> }) {
  if (ids.length === 0) return null;
  return (
    <div className="rr-evidence-list" role="group" aria-label="Cited evidence">
      {[...new Set(ids)].map((id) => (
        <EvidenceReference key={id} id={id} item={evidence.get(id)} cited={cited[id] ?? []} />
      ))}
    </div>
  );
}
