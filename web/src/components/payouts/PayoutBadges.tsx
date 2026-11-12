import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  FlaskConical,
  Hourglass,
  LoaderCircle,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import type { ServerCheck } from '@shared/api/contracts';
import {
  CANCELLATION_STATE_INFO,
  PAYPAL_TARGET_INFO,
  PROPOSAL_STATUS_INFO,
  SANDBOX_NOTICE,
  SUBMISSION_STATE_INFO,
  type CancellationState,
  type ProposalStatus,
  type SubmissionState,
} from '@shared/domain/payouts';
import type { ProviderMode } from '@shared/domain/types';
import { usePayPalTarget } from '../../hooks/usePayPalTarget';
import { ProviderModeBadge } from '../status/StatusBadges';
import { Badge, type Tone } from '../ui/Badge';
import '../../styles/payouts.css';

const PROPOSAL_VISUAL: Record<ProposalStatus, { tone: Tone; icon: LucideIcon }> = {
  pending_approval: { tone: 'warning', icon: ShieldCheck },
  approved: { tone: 'success', icon: CircleCheck },
  rejected: { tone: 'neutral', icon: CircleX },
  withdrawn: { tone: 'neutral', icon: Undo2 },
  expired: { tone: 'neutral', icon: Hourglass },
  superseded: { tone: 'neutral', icon: RotateCcw },
};

export function ProposalStatusBadge({ status, size }: { status: ProposalStatus; size?: 'sm' | 'md' }) {
  const { t } = usePayPalTarget();
  const info = PROPOSAL_STATUS_INFO[status];
  const visual = PROPOSAL_VISUAL[status];
  return <Badge tone={visual.tone} icon={visual.icon} label={t(info.label)} description={t(info.description)} size={size} />;
}

/** Provider mode of a payment attempt. Records answered by a local stub are never labelled PayPal Sandbox. */
export function PayPalModeBadge({ mode, size }: { mode: ProviderMode; size?: 'sm' | 'md' }) {
  const { target } = usePayPalTarget();
  if (mode !== 'sandbox' || target !== 'local_stub') return <ProviderModeBadge mode={mode} size={size} />;
  return (
    <Badge
      tone="warning"
      icon={FlaskConical}
      label={PAYPAL_TARGET_INFO.local_stub.label}
      description="Answered by a local stub that imitates PayPal for testing. Not a PayPal Sandbox record; nothing was sent to PayPal."
      size={size}
    />
  );
}

const SUBMISSION_VISUAL: Record<SubmissionState, { tone: Tone; icon: LucideIcon }> = {
  prepared: { tone: 'info', icon: CircleDashed },
  sending: { tone: 'progress', icon: Send },
  accepted: { tone: 'success', icon: CircleCheck },
  rejected: { tone: 'critical', icon: CircleX },
  not_processed: { tone: 'warning', icon: Clock },
  outcome_unknown: { tone: 'warning', icon: TriangleAlert },
  blocked_by_policy: { tone: 'neutral', icon: Ban },
  needs_manual_reconciliation: { tone: 'critical', icon: ShieldAlert },
  reconciled_not_created: { tone: 'neutral', icon: CircleX },
};

export function SubmissionStateBadge({ state, size }: { state: SubmissionState; size?: 'sm' | 'md' }) {
  const { t } = usePayPalTarget();
  const info = SUBMISSION_STATE_INFO[state];
  const visual = SUBMISSION_VISUAL[state];
  return <Badge tone={visual.tone} icon={visual.icon} label={t(info.label)} description={t(info.description)} size={size} />;
}

const CANCELLATION_VISUAL: Record<CancellationState, { tone: Tone; icon: LucideIcon }> = {
  prepared: { tone: 'info', icon: CircleDashed },
  prechecking: { tone: 'progress', icon: LoaderCircle },
  sending: { tone: 'progress', icon: Send },
  succeeded: { tone: 'success', icon: CircleCheck },
  already_cancelled: { tone: 'success', icon: CircleCheck },
  not_applicable: { tone: 'neutral', icon: CircleDashed },
  not_processed: { tone: 'warning', icon: Clock },
  outcome_unknown: { tone: 'warning', icon: TriangleAlert },
  needs_manual_reconciliation: { tone: 'critical', icon: ShieldAlert },
};

export function CancellationStateBadge({ state, size }: { state: CancellationState; size?: 'sm' | 'md' }) {
  const { t } = usePayPalTarget();
  const info = CANCELLATION_STATE_INFO[state];
  const visual = CANCELLATION_VISUAL[state];
  return <Badge tone={visual.tone} icon={visual.icon} label={t(info.label)} description={t(info.description)} size={size} />;
}

/** Shown wherever a Sandbox payment action or result appears. */
export function SandboxNotice({ text = SANDBOX_NOTICE }: { text?: string }) {
  const { target, t } = usePayPalTarget();
  return (
    <p className={target === 'local_stub' ? 'rr-sandbox-notice rr-sandbox-notice--stub' : 'rr-sandbox-notice'}>
      <FlaskConical size={16} aria-hidden="true" />
      <span>{t(text)}</span>
    </p>
  );
}

export function ServerChecks({ checks }: { checks: ServerCheck[] }) {
  return (
    <ul role="list" className="rr-checks">
      {checks.map((c) => (
        <li key={c.code} className={c.passed ? 'rr-checks__item' : 'rr-checks__item rr-checks__item--failed'}>
          {c.passed ? <CircleCheck size={16} aria-hidden="true" /> : <CircleX size={16} aria-hidden="true" />}
          <span>
            <span className="rr-checks__label">
              {c.label}: {c.passed ? 'passed' : 'not met'}
            </span>
            <span className="rr-checks__detail">{c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
