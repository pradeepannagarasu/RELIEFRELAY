import { CircleExclamationPoint, RefreshCw, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '../../services/apiClient';
import { Button } from './Button';

export function LoadingState({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className="rr-loading" role="status" aria-live="polite">
      <span className="rr-visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="rr-skeleton" aria-hidden="true" />
      ))}
    </div>
  );
}

interface ErrorStateProps {
  title: string;
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}

export function ErrorState({ title, error, onRetry, retrying }: ErrorStateProps) {
  const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <div className="rr-state rr-state--error" role="alert">
      <CircleExclamationPoint size={20} aria-hidden="true" className="rr-state__icon" />
      <div className="rr-state__body">
        <p className="rr-state__title">{title}</p>
        <p className="rr-state__text">{message}</p>
        {requestId && (
          <p className="rr-state__meta">
            Reference for support: <span className="rr-mono">{requestId}</span>
          </p>
        )}
        {onRetry && (
          <div className="rr-state__actions">
            <Button size="sm" icon={<RefreshCw size={14} aria-hidden="true" />} onClick={onRetry} loading={retrying}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="rr-state rr-state--empty">
      <Icon size={20} aria-hidden="true" className="rr-state__icon" />
      <div className="rr-state__body">
        <p className="rr-state__title">{title}</p>
        {children && <div className="rr-state__text">{children}</div>}
      </div>
    </div>
  );
}
