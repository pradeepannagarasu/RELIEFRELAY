import { useId, type ReactNode } from 'react';

interface PanelProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  /** Remove body padding, e.g. for full-bleed tables. */
  flush?: boolean;
  className?: string;
}

export function Panel({ title, description, actions, footer, children, flush = false, className }: PanelProps) {
  const titleId = useId();
  return (
    <section className={['rr-panel', className].filter(Boolean).join(' ')} aria-labelledby={titleId}>
      <header className="rr-panel__header">
        <div className="rr-panel__heading">
          <h2 id={titleId} className="rr-panel__title">
            {title}
          </h2>
          {description && <p className="rr-panel__description">{description}</p>}
        </div>
        {actions && <div className="rr-panel__actions">{actions}</div>}
      </header>
      <div className={flush ? 'rr-panel__body rr-panel__body--flush' : 'rr-panel__body'}>{children}</div>
      {footer && <footer className="rr-panel__footer">{footer}</footer>}
    </section>
  );
}
