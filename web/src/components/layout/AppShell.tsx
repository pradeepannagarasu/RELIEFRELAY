import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { DemoNotices } from './DemoNotices';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export function AppShell() {
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [navOpen, setNavOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const firstRender = useRef(true);
  const restoreFocusToMenu = useRef(false);

  const closeNav = useCallback(() => {
    restoreFocusToMenu.current = true;
    setNavOpen(false);
  }, []);

  const focusHeadingPending = useRef(false);

  useEffect(() => {
    setNavOpen(false);
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    focusHeadingPending.current = true;
  }, [location.pathname]);

  useEffect(() => {
    if (isDesktop) setNavOpen(false);
  }, [isDesktop]);

  const drawerOpen = !isDesktop && navOpen;

  // Runs once the main area is no longer inert; focusing an inert element silently fails.
  useEffect(() => {
    if (drawerOpen) return;
    if (focusHeadingPending.current) {
      focusHeadingPending.current = false;
      restoreFocusToMenu.current = false;
      document.querySelector<HTMLElement>('[data-page-heading]')?.focus();
    } else if (restoreFocusToMenu.current) {
      restoreFocusToMenu.current = false;
      menuButtonRef.current?.focus();
    }
  }, [drawerOpen, location.pathname]);

  return (
    <div className="rr-shell">
      <a href="#main" className="rr-skip-link">
        Skip to main content
      </a>
      <Sidebar asDrawer={!isDesktop} open={drawerOpen} onClose={closeNav} />
      <div className="rr-shell__main" inert={drawerOpen}>
        <TopBar ref={menuButtonRef} showMenuButton={!isDesktop} navOpen={drawerOpen} onOpenNav={() => setNavOpen(true)} />
        <DemoNotices />
        <main id="main" className="rr-main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
