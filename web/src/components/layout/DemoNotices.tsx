import { Database, Eye, FlaskConical } from 'lucide-react';
import { useSession } from '../../hooks/useSession';

/** Always-visible notices: the data set is synthetic, and how the public demonstration differs from the private one. */
export function DemoNotices() {
  const { data: session } = useSession();
  const synthetic = session?.organisation.isSynthetic !== false;
  const publicReadOnly = session?.environment.publicReadOnly === true;
  const judgeDemo = session?.environment.judgeDemo === true;
  if (!synthetic && !publicReadOnly && !judgeDemo) return null;

  return (
    <div className="rr-demo-notices">
      {synthetic && (
        <p className="rr-demo-banner rr-demo-banner--synthetic">
          <Database size={16} aria-hidden="true" />
          <span>
            <strong>SYNTHETIC DEMONSTRATION DATA</strong> — These records are fictional and do not represent real beneficiaries or humanitarian
            payments.
          </span>
        </p>
      )}
      {judgeDemo && (
        <p className="rr-demo-banner rr-demo-banner--readonly">
          <FlaskConical size={16} aria-hidden="true" />
          <span>
            <strong>Public Judge Demo with simulated payments.</strong> Investigate cases, import synthetic CSV files, propose recoveries and approve
            them as a different demo identity. Payouts here go to a local PayPal stub on the server: nothing is sent to PayPal, and simulated results
            are labelled “Local PayPal stub”, never as PayPal responses. The genuine PayPal Sandbox integration runs separately and cannot be reached
            from this site. Administrative settings are not available.
          </span>
        </p>
      )}
      {publicReadOnly && (
        <p className="rr-demo-banner rr-demo-banner--readonly">
          <Eye size={16} aria-hidden="true" />
          <span>
            <strong>Public read-only demonstration.</strong> You are viewing as a read-only account. Approving, submitting and cancelling payouts,
            allowlist changes, imports, notes and role switching are disabled here, and the server rejects them. Records labelled PayPal Sandbox use
            test money only; original payment statuses in the synthetic data are simulated, not PayPal responses.
          </span>
        </p>
      )}
    </div>
  );
}
