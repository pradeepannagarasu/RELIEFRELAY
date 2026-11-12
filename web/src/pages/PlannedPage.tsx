import { ArrowLeft, Construction } from 'lucide-react';
import type { NavItem } from '../components/layout/navigation';
import { ButtonLink } from '../components/ui/Button';
import { PageHeader } from '../components/ui/PageHeader';
import { Panel } from '../components/ui/Panel';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

/** Honest placeholder for a navigation destination whose feature has not been built yet. */
export function PlannedPage({ item }: { item: NavItem }) {
  useDocumentTitle(item.label);
  return (
    <div className="rr-page">
      <PageHeader
        title={item.label}
        description={item.summary}
        eyebrow={
          <span className="rr-planned-tag">
            <Construction size={14} aria-hidden="true" />
            Planned{item.phase ? ` for build phase ${item.phase}` : ''}
          </span>
        }
      />
      <Panel
        title="Not available yet"
        description="This area has not been built. Nothing on this page is simulated or partially working."
        footer={
          <ButtonLink to="/" icon={<ArrowLeft size={16} aria-hidden="true" />}>
            Back to overview
          </ButtonLink>
        }
      >
        <p className="rr-planned-intro">When complete, this area will provide:</p>
        <ul className="rr-planned-list">
          {item.capabilities.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
