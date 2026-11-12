import type { LucideIcon } from 'lucide-react';

export type Tone = 'success' | 'warning' | 'critical' | 'info' | 'progress' | 'neutral';

interface BadgeProps {
  tone: Tone;
  label: string;
  icon?: LucideIcon;
  /** Supplementary tooltip. Anything essential must also be shown as visible text elsewhere. */
  description?: string;
  size?: 'sm' | 'md';
}

/** Status label that always pairs colour with an icon and text. */
export function Badge({ tone, label, icon: Icon, description, size = 'md' }: BadgeProps) {
  return (
    <span className={`rr-badge rr-badge--${tone} rr-badge--${size}`} title={description}>
      {Icon && <Icon size={size === 'sm' ? 12 : 14} strokeWidth={2.25} aria-hidden="true" />}
      <span>{label}</span>
    </span>
  );
}
