import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Tone } from './Badge';

interface StatProps {
  label: string;
  value: ReactNode;
  icon: LucideIcon;
  tone?: Tone;
  supporting?: ReactNode;
}

export function Stat({ label, value, icon: Icon, tone = 'neutral', supporting }: StatProps) {
  return (
    <div className="rr-stat">
      <dt className="rr-stat__label">
        <span className={`rr-stat__icon rr-stat__icon--${tone}`} aria-hidden="true">
          <Icon size={16} strokeWidth={2} />
        </span>
        {label}
      </dt>
      <dd className="rr-stat__value rr-num">{value}</dd>
      {supporting && <dd className="rr-stat__supporting">{supporting}</dd>}
    </div>
  );
}
