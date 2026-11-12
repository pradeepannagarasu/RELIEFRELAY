import { FlaskConical, X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { useSession } from '../../hooks/useSession';
import { Logo } from './Logo';
import { NAV_SECTIONS, SETTINGS_NAV_ITEM, type NavItem } from './navigation';

interface SidebarProps {
  /** Drawer mode is used below the desktop breakpoint. */
  asDrawer: boolean;
  open: boolean;
  onClose: () => void;
}

function NavEntry({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <li>
      <NavLink to={item.to} end={item.to === '/'} className="rr-nav__link">
        <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
        <span className="rr-nav__label">{item.label}</span>
        {item.status === 'planned' && (
          <span className="rr-nav__planned">
            Planned<span className="rr-visually-hidden">, not yet available</span>
          </span>
        )}
      </NavLink>
    </li>
  );
}

export function Sidebar({ asDrawer, open, onClose }: SidebarProps) {
  const { data: session } = useSession();
  const closeRef = useRef<HTMLButtonElement>(null);
  const idPrefix = useId();

  useEffect(() => {
    if (!asDrawer || !open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [asDrawer, open, onClose]);

  const hidden = asDrawer && !open;
  const mode = session?.environment.providerMode;

  return (
    <>
      {asDrawer && open && <div className="rr-sidebar__backdrop" onClick={onClose} aria-hidden="true" />}
      <div
        id="primary-navigation"
        className={['rr-sidebar', asDrawer ? 'rr-sidebar--drawer' : '', open ? 'rr-sidebar--open' : ''].join(' ')}
        hidden={hidden}
        {...(asDrawer ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Navigation' } : { role: 'complementary', 'aria-label': 'Application sidebar' })}
      >
        <div className="rr-sidebar__brand">
          <Logo inverse />
          {asDrawer && (
            <button ref={closeRef} type="button" className="rr-icon-button rr-icon-button--inverse" onClick={onClose}>
              <X size={20} aria-hidden="true" />
              <span className="rr-visually-hidden">Close navigation</span>
            </button>
          )}
        </div>

        <nav className="rr-nav" aria-label="Primary">
          {NAV_SECTIONS.map((section, index) => (
            <div key={section.label} className="rr-nav__section">
              <p className="rr-nav__section-label" id={`${idPrefix}-section-${index}`}>
                {section.label}
              </p>
              <ul role="list" aria-labelledby={`${idPrefix}-section-${index}`}>
                {section.items.map((item) => (
                  <NavEntry key={item.to} item={item} />
                ))}
              </ul>
            </div>
          ))}
          <ul role="list" className="rr-nav__footer-list">
            <NavEntry item={SETTINGS_NAV_ITEM} />
          </ul>
        </nav>

        {mode === 'simulation' && (
          <div className="rr-sidebar__notice">
            <p className="rr-sidebar__notice-title">
              <FlaskConical size={14} aria-hidden="true" />
              Simulation mode
            </p>
            <p className="rr-sidebar__notice-text">
              Provider events are synthetic. No PayPal requests are made and no money moves.
            </p>
          </div>
        )}
        {mode === 'sandbox' && session?.environment.paypalTarget === 'local_stub' && (
          <div className="rr-sidebar__notice">
            <p className="rr-sidebar__notice-title">
              <FlaskConical size={14} aria-hidden="true" />
              Local PayPal stub
            </p>
            <p className="rr-sidebar__notice-text">
              Payment actions are answered by a stub inside the ReliefRelay server for testing. Nothing is sent to PayPal, not even PayPal Sandbox.
            </p>
          </div>
        )}
        {mode === 'sandbox' && session?.environment.paypalTarget !== 'local_stub' && (
          <div className="rr-sidebar__notice">
            <p className="rr-sidebar__notice-title">
              <FlaskConical size={14} aria-hidden="true" />
              PayPal Sandbox
            </p>
            <p className="rr-sidebar__notice-text">
              Approved recovery actions are sent to PayPal Sandbox with test money only. Sandbox results do not show real-world delivery.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
