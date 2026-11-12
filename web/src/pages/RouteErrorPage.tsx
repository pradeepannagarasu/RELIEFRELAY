import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { PageHeader } from '../components/ui/PageHeader';
import { ErrorState } from '../components/ui/States';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

/** Shown when a page fails to render. Technical details stay in the browser console, not on screen. */
export function RouteErrorPage({ standalone = false }: { standalone?: boolean }) {
  useDocumentTitle('Something went wrong');
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `The page returned ${error.status} ${error.statusText}.`
    : 'This page failed to display. Your data has not been changed.';

  return (
    <div className={standalone ? 'rr-page rr-main' : 'rr-page'}>
      <PageHeader title="Something went wrong" />
      <ErrorState title="This page could not be displayed" error={new Error(message)} onRetry={() => window.location.reload()} />
    </div>
  );
}
