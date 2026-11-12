import { ArrowLeft, FileSearch } from 'lucide-react';
import { ButtonLink } from '../components/ui/Button';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/States';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function NotFoundPage() {
  useDocumentTitle('Page not found');
  return (
    <div className="rr-page">
      <PageHeader title="Page not found" description="The address you followed does not match any page in ReliefRelay." />
      <EmptyState icon={FileSearch} title="Nothing here">
        <p>Check the address, or return to the overview.</p>
        <div className="rr-state__actions">
          <ButtonLink to="/" icon={<ArrowLeft size={16} aria-hidden="true" />}>
            Back to overview
          </ButtonLink>
        </div>
      </EmptyState>
    </div>
  );
}
