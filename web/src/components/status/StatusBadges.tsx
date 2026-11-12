import {
  Ban,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  Clock,
  FlaskConical,
  Hourglass,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Undo2,
  UserRound,
  Cpu,
  FileSpreadsheet,
  FilePen,
  FileCheck2,
  FileX2,
  GitCompareArrows,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import { CASE_BASIS_INFO, CASE_STATE_INFO } from '@shared/domain/cases';
import { FINDING_INFO, type FindingCode } from '@shared/domain/findings';
import { ROW_OUTCOME_INFO, type ImportStatus, type RowOutcome } from '@shared/domain/imports';
import {
  PAYOUT_BATCH_STATUS_INFO,
  PAYOUT_ITEM_STATUS_INFO,
  type PayoutBatchStatus,
  type PayoutItemStatus,
} from '@shared/domain/paypal';
import type { StatusSource } from '@shared/domain/status';
import type { CaseBasis, CaseState, EventSource, ProviderMode } from '@shared/domain/types';
import { Badge, type Tone } from '../ui/Badge';

export const PROVIDER_STATUS_VISUAL: Record<PayoutItemStatus, { tone: Tone; icon: LucideIcon }> = {
  SUCCESS: { tone: 'success', icon: CircleCheck },
  PENDING: { tone: 'progress', icon: Clock },
  ONHOLD: { tone: 'warning', icon: CirclePause },
  UNCLAIMED: { tone: 'warning', icon: Hourglass },
  RETURNED: { tone: 'critical', icon: Undo2 },
  FAILED: { tone: 'critical', icon: CircleX },
  BLOCKED: { tone: 'critical', icon: Ban },
  REFUNDED: { tone: 'neutral', icon: RotateCcw },
  REVERSED: { tone: 'neutral', icon: RotateCcw },
};

export function ProviderStatusBadge({ status, size }: { status: PayoutItemStatus; size?: 'sm' | 'md' }) {
  const info = PAYOUT_ITEM_STATUS_INFO[status];
  const visual = PROVIDER_STATUS_VISUAL[status];
  return <Badge tone={visual.tone} icon={visual.icon} label={info.label} description={info.description} size={size} />;
}

const CASE_STATE_VISUAL: Record<CaseState, { tone: Tone; icon: LucideIcon }> = {
  open: { tone: 'info', icon: CircleDashed },
  investigating: { tone: 'progress', icon: LoaderCircle },
  awaiting_approval: { tone: 'warning', icon: ShieldCheck },
  recovery_submitted: { tone: 'progress', icon: Clock },
  resolved: { tone: 'success', icon: CircleCheck },
  closed: { tone: 'neutral', icon: CircleX },
};

export function CaseStateBadge({ state, size }: { state: CaseState; size?: 'sm' | 'md' }) {
  const info = CASE_STATE_INFO[state];
  const visual = CASE_STATE_VISUAL[state];
  return <Badge tone={visual.tone} icon={visual.icon} label={info.label} description={info.description} size={size} />;
}

const BATCH_STATUS_VISUAL: Record<PayoutBatchStatus, { tone: Tone; icon: LucideIcon }> = {
  PENDING: { tone: 'progress', icon: Clock },
  PROCESSING: { tone: 'progress', icon: LoaderCircle },
  SUCCESS: { tone: 'success', icon: CircleCheck },
  DENIED: { tone: 'critical', icon: Ban },
  CANCELED: { tone: 'neutral', icon: CircleX },
};

export function BatchStatusBadge({ status, size }: { status: PayoutBatchStatus; size?: 'sm' | 'md' }) {
  const info = PAYOUT_BATCH_STATUS_INFO[status];
  const visual = BATCH_STATUS_VISUAL[status];
  return <Badge tone={visual.tone} icon={visual.icon} label={info.label} description={info.description} size={size} />;
}

const MODE_LABEL: Record<ProviderMode, { label: string; description: string; tone: Tone }> = {
  simulation: {
    label: 'Simulation',
    description: 'No request was sent to PayPal. Provider references and events are synthetic.',
    tone: 'info',
  },
  sandbox: { label: 'PayPal Sandbox', description: 'Processed by the PayPal Sandbox with test funds only.', tone: 'progress' },
  live: { label: 'Live', description: 'Real funds.', tone: 'critical' },
};

export function ProviderModeBadge({ mode, size = 'sm' }: { mode: ProviderMode; size?: 'sm' | 'md' }) {
  const info = MODE_LABEL[mode];
  return <Badge tone={info.tone} icon={FlaskConical} label={info.label} description={info.description} size={size} />;
}

const SOURCE_VISUAL: Record<EventSource, { label: string; icon: LucideIcon }> = {
  simulation: { label: 'Simulated provider', icon: FlaskConical },
  sandbox: { label: 'PayPal Sandbox', icon: FlaskConical },
  operator: { label: 'Operator', icon: UserRound },
  system: { label: 'ReliefRelay', icon: Cpu },
  import: { label: 'CSV import', icon: FileSpreadsheet },
};

const STATUS_SOURCE: Record<StatusSource, { label: string; description: string; icon: LucideIcon }> = {
  provider: { label: 'Provider', description: 'Reported by the payment provider.', icon: FlaskConical },
  imported: {
    label: 'Imported record',
    description: 'Taken from an uploaded CSV record. Not confirmed by the payment provider.',
    icon: FileSpreadsheet,
  },
};

/** A status taken from an imported record. Worded so it never reads as provider confirmation. */
export function ImportedStatusBadge({ status, size }: { status: PayoutItemStatus; size?: 'sm' | 'md' }) {
  const info = PAYOUT_ITEM_STATUS_INFO[status];
  const visual = PROVIDER_STATUS_VISUAL[status];
  return (
    <Badge
      tone={visual.tone}
      icon={visual.icon}
      label={`Recorded as ${info.label.toLowerCase()}`}
      description={`${info.description} ${STATUS_SOURCE.imported.description}`}
      size={size}
    />
  );
}

/** The status used for case work, always labelled with where it came from. */
export function ReportedStatusBadge({ status, source, size }: { status: PayoutItemStatus; source: StatusSource; size?: 'sm' | 'md' }) {
  const info = PAYOUT_ITEM_STATUS_INFO[status];
  const visual = PROVIDER_STATUS_VISUAL[status];
  const origin = STATUS_SOURCE[source];
  return (
    <span className="rr-reported-status">
      {source === 'imported' ? (
        <ImportedStatusBadge status={status} size={size} />
      ) : (
        <Badge tone={visual.tone} icon={visual.icon} label={info.label} description={`${info.description} ${origin.description}`} size={size} />
      )}
      <span className="rr-source">
        <origin.icon size={12} aria-hidden="true" />
        {origin.label}
      </span>
    </span>
  );
}

const BASIS_VISUAL: Record<CaseBasis, { tone: Tone; icon: LucideIcon }> = {
  provider_confirmed: { tone: 'neutral', icon: FlaskConical },
  imported_record: { tone: 'neutral', icon: FileSpreadsheet },
  reconciliation_conflict: { tone: 'warning', icon: GitCompareArrows },
};

export function CaseBasisBadge({ basis, size = 'sm' }: { basis: CaseBasis; size?: 'sm' | 'md' }) {
  const info = CASE_BASIS_INFO[basis];
  const visual = BASIS_VISUAL[basis];
  return <Badge tone={visual.tone} icon={visual.icon} label={info.label} description={info.description} size={size} />;
}

const IMPORT_STATUS_VISUAL: Record<ImportStatus, { tone: Tone; icon: LucideIcon; label: string; description: string }> = {
  draft: { tone: 'neutral', icon: FilePen, label: 'Draft', description: 'Uploaded. Columns have not been mapped and validated yet.' },
  validated: { tone: 'info', icon: FileSpreadsheet, label: 'Ready to review', description: 'Validated. Nothing has been recorded until it is committed.' },
  committed: { tone: 'success', icon: FileCheck2, label: 'Committed', description: 'Records from this file have been added.' },
  discarded: { tone: 'neutral', icon: FileX2, label: 'Discarded', description: 'Discarded without recording anything.' },
};

export function ImportStatusBadge({ status, size = 'sm' }: { status: ImportStatus; size?: 'sm' | 'md' }) {
  const visual = IMPORT_STATUS_VISUAL[status];
  return <Badge tone={visual.tone} icon={visual.icon} label={visual.label} description={visual.description} size={size} />;
}

const OUTCOME_VISUAL: Record<RowOutcome, { tone: Tone; icon: LucideIcon }> = {
  new_payment: { tone: 'success', icon: CircleCheck },
  status_update: { tone: 'info', icon: RotateCcw },
  unchanged: { tone: 'neutral', icon: CircleDashed },
  rejected: { tone: 'critical', icon: CircleX },
  blank: { tone: 'neutral', icon: CircleDashed },
};

export function RowOutcomeBadge({ outcome, size = 'sm' }: { outcome: RowOutcome; size?: 'sm' | 'md' }) {
  const info = ROW_OUTCOME_INFO[outcome];
  const visual = OUTCOME_VISUAL[outcome];
  return <Badge tone={visual.tone} icon={visual.icon} label={info.label} description={info.description} size={size} />;
}

export function FindingBadge({ code, size = 'sm' }: { code: FindingCode; size?: 'sm' | 'md' }) {
  const info = FINDING_INFO[code];
  const tone: Tone = info.severity === 'critical' ? 'critical' : info.severity === 'warning' ? 'warning' : 'info';
  return <Badge tone={tone} icon={info.severity === 'info' ? CircleDashed : ShieldAlert} label={info.label} description={info.description} size={size} />;
}

export function EventSourceLabel({ source }: { source: EventSource }) {
  const { label, icon: Icon } = SOURCE_VISUAL[source];
  return (
    <span className="rr-source">
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}
