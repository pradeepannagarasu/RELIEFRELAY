import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { ALL_NAV_ITEMS } from './components/layout/navigation';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { AuditPage } from './pages/AuditPage';
import { CaseDetailPage } from './pages/CaseDetailPage';
import { CasesPage } from './pages/CasesPage';
import { ImportDetailPage } from './pages/ImportDetailPage';
import { ImportPage } from './pages/ImportPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OverviewPage } from './pages/OverviewPage';
import { PlannedPage } from './pages/PlannedPage';
import { ProposalPage } from './pages/ProposalPage';
import { RouteErrorPage } from './pages/RouteErrorPage';
import { SettingsPage } from './pages/SettingsPage';

const plannedRoutes = ALL_NAV_ITEMS.filter((item) => item.status === 'planned').map((item) => ({
  path: item.to.slice(1),
  element: <PlannedPage item={item} />,
}));

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorPage standalone />,
    children: [
      {
        // Page-level failures render inside the shell so navigation stays usable.
        errorElement: <RouteErrorPage />,
        children: [
          { index: true, element: <OverviewPage /> },
          { path: 'cases', element: <CasesPage /> },
          { path: 'cases/:id', element: <CaseDetailPage /> },
          { path: 'import', element: <ImportPage /> },
          { path: 'import/:id', element: <ImportDetailPage /> },
          { path: 'approvals', element: <ApprovalsPage /> },
          { path: 'approvals/:id', element: <ProposalPage /> },
          { path: 'audit', element: <AuditPage /> },
          { path: 'settings', element: <SettingsPage /> },
          ...plannedRoutes,
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
