import { Database, FlaskConical, Menu } from 'lucide-react';
import { forwardRef } from 'react';
import { useSession } from '../../hooks/useSession';
import { DemoIdentitySwitcher } from './DemoIdentitySwitcher';
import { Logo } from './Logo';

const ROLE_LABEL = { admin: 'Administrator', approver: 'Approver', operator: 'Payment operator', viewer: 'Viewer' } as const;

interface TopBarProps {
  showMenuButton: boolean;
  navOpen: boolean;
  onOpenNav: () => void;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export const TopBar = forwardRef<HTMLButtonElement, TopBarProps>(function TopBar({ showMenuButton, navOpen, onOpenNav }, menuRef) {
  const { data: session, isError } = useSession();

  return (
    <header className="rr-topbar">
      <div className="rr-topbar__start">
        {showMenuButton && (
          <>
            <button
              ref={menuRef}
              type="button"
              className="rr-icon-button"
              aria-expanded={navOpen}
              aria-controls="primary-navigation"
              onClick={onOpenNav}
            >
              <Menu size={20} aria-hidden="true" />
              <span className="rr-visually-hidden">Open navigation</span>
            </button>
            <Logo />
          </>
        )}
        {session && (
          <div className="rr-topbar__org">
            <span className="rr-topbar__org-name">{session.organisation.name}</span>
            {session.organisation.isSynthetic && (
              <span className="rr-topbar__tag">
                <Database size={12} aria-hidden="true" />
                Synthetic data
              </span>
            )}
          </div>
        )}
        {isError && <span className="rr-topbar__org-name">Session unavailable</span>}
      </div>

      <div className="rr-topbar__end">
        {session?.environment.providerMode === 'simulation' && (
          <span className="rr-env-pill" title="No request is sent to PayPal. Provider references and events are synthetic.">
            <FlaskConical size={14} aria-hidden="true" />
            <span>
              Simulation<span className="rr-env-pill__long"> mode</span>
            </span>
          </span>
        )}
        {session?.environment.providerMode === 'sandbox' && session.environment.paypalTarget === 'local_stub' && (
          <span className="rr-env-pill rr-env-pill--stub" title="Payment actions are answered by a local stub for testing. Nothing is sent to PayPal, not even PayPal Sandbox.">
            <FlaskConical size={14} aria-hidden="true" />
            <span>
              Local PayPal stub<span className="rr-env-pill__long">: not PayPal</span>
            </span>
          </span>
        )}
        {session?.environment.providerMode === 'sandbox' && session.environment.paypalTarget !== 'local_stub' && (
          <span className="rr-env-pill rr-env-pill--sandbox" title="Payment actions use PayPal Sandbox test money only. Sandbox results do not show real-world delivery.">
            <FlaskConical size={14} aria-hidden="true" />
            <span>
              PayPal Sandbox<span className="rr-env-pill__long">: test money</span>
            </span>
          </span>
        )}
        {session?.environment.demoRoleSwitcher && <DemoIdentitySwitcher />}
        {session && (
          <div className="rr-user">
            <span className="rr-user__avatar" aria-hidden="true">
              {session.environment.publicReadOnly ? 'PV' : initials(session.user.displayName)}
            </span>
            <span className="rr-user__text">
              <span className="rr-user__name">{session.environment.publicReadOnly ? 'Public visitor' : session.user.displayName}</span>
              <span className="rr-user__role">{session.environment.publicReadOnly ? 'Read-only' : ROLE_LABEL[session.user.role]}</span>
            </span>
          </div>
        )}
      </div>
    </header>
  );
});
