import { useId } from 'react';
import { useDemoIdentities, useSwitchDemoIdentity } from '../../hooks/usePayouts';
import '../../styles/payouts.css';

const ROLE_LABEL = { admin: 'Administrator', approver: 'Approver', operator: 'Payment operator', viewer: 'Viewer' } as const;

/** Development-only role demonstration. Switches between seeded demo accounts; it is not authentication. */
export function DemoIdentitySwitcher() {
  const { data } = useDemoIdentities(true);
  const change = useSwitchDemoIdentity();
  const id = useId();
  if (!data) return null;
  return (
    <div className="rr-demo-identity" title={data.notice}>
      <label htmlFor={id} className="rr-demo-identity__label">
        Role demo<span className="rr-demo-identity__long"> (not sign-in)</span>
      </label>
      <select id={id} className="rr-select" value={data.currentUserId} disabled={change.isPending} onChange={(e) => change.mutate(e.target.value)} aria-describedby={`${id}-notice`}>
        {data.identities.map((u) => (
          <option key={u.id} value={u.id}>
            {u.displayName}, {ROLE_LABEL[u.role]}
          </option>
        ))}
      </select>
      <span id={`${id}-notice`} className="rr-visually-hidden">
        {data.notice}
      </span>
    </div>
  );
}
