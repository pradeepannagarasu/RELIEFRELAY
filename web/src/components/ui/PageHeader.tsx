import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}

export function PageHeader({ title, description, actions, eyebrow }: PageHeaderProps) {
  return (
    <header className="rr-page-header">
      <div className="rr-page-header__text">
        {eyebrow && <div className="rr-page-header__eyebrow">{eyebrow}</div>}
        {/* Receives focus after client-side navigation so screen readers announce the new page. */}
        <h1 className="rr-page-header__title" tabIndex={-1} data-page-heading>
          {title}
        </h1>
        {description && <p className="rr-page-header__description">{description}</p>}
      </div>
      {actions && <div className="rr-page-header__actions">{actions}</div>}
    </header>
  );
}
