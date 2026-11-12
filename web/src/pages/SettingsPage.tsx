import { CircleCheck, CircleX, PlugZap } from 'lucide-react';
import type { ReactNode } from 'react';
import { PAYPAL_TARGET_INFO } from '@shared/domain/payouts';
import { PayPalModeBadge, SandboxNotice } from '../components/payouts/PayoutBadges';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { DateTime } from '../components/ui/DateTime';
import { PageHeader } from '../components/ui/PageHeader';
import { Panel } from '../components/ui/Panel';
import { ErrorState, LoadingState } from '../components/ui/States';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { usePayPalTarget } from '../hooks/usePayPalTarget';
import { useConnectionCheck, usePayPalIntegration } from '../hooks/usePayouts';
import { useSession } from '../hooks/useSession';
import { formatMoneyValue } from '../lib/format';

const ROLE_LABEL = { admin: 'Administrator', approver: 'Approver', operator: 'Payment operator', viewer: 'Viewer' } as const;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rr-facts__item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function YesNo({ value, yes, no }: { value: boolean; yes: string; no: string }) {
  return value ? <Badge tone="success" icon={CircleCheck} size="sm" label={yes} /> : <Badge tone="neutral" icon={CircleX} size="sm" label={no} />;
}

function PayPalPanel() {
  const { data, error, isPending, isError, refetch, isFetching } = usePayPalIntegration();
  const check = useConnectionCheck();
  const { t } = usePayPalTarget();
  return (
    <Panel title={t('PayPal Sandbox')} description="Connection status only. Client credentials and webhook secrets are never displayed or sent to the browser.">
      {isPending && <LoadingState label={t('Loading PayPal Sandbox status')} rows={3} />}
      {isError && <ErrorState title={t('PayPal Sandbox status could not be loaded')} error={error} onRetry={() => void refetch()} retrying={isFetching} />}
      {data && (
        <div className="rr-stack">
          <SandboxNotice text={data.sandboxNotice} />
          <dl className="rr-facts">
            <Fact label="Provider mode">
              <PayPalModeBadge mode={data.providerMode} size="md" />
            </Fact>
            <Fact label="Requests go to">
              {PAYPAL_TARGET_INFO[data.target].label}
              <span className="rr-table__secondary">{PAYPAL_TARGET_INFO[data.target].description}</span>
            </Fact>
            <Fact label="API host">
              <span className="rr-mono">{data.apiHost}</span>
            </Fact>
            <Fact label="Credentials">
              <YesNo value={data.configured} yes="Configured on the server" no="Not configured" />
            </Fact>
            <Fact label="Payment actions">
              <YesNo value={data.payoutsEnabled} yes="Switched on" no="Switched off" />
            </Fact>
            <Fact label="Webhook">
              <YesNo value={data.webhook.configured} yes={`Listening on port ${data.webhook.port}`} no="No webhook ID configured" />
            </Fact>
            <Fact label="Last verified webhook">{data.webhook.lastVerifiedAt ? <DateTime value={data.webhook.lastVerifiedAt} /> : 'None received'}</Fact>
          </dl>
          {data.canRunConnectionCheck && (
            <div>
              <div className="rr-form__actions">
                <Button icon={<PlugZap size={16} aria-hidden="true" />} loading={check.isPending} onClick={() => check.mutate()} disabled={!data.configured}>
                  Run connection check
                </Button>
                <span className="rr-field__hint">Requests an access token and checks the Payouts permission. Sends no payment.</span>
              </div>
              {check.isError && (
                <p className="rr-inline-error" role="alert">
                  {check.error.message}
                </p>
              )}
            </div>
          )}
          {data.lastConnectionCheck && (
            <p className="rr-field__hint">
              Last connection check: {data.lastConnectionCheck.ok ? 'passed' : 'failed'}, <DateTime value={data.lastConnectionCheck.checkedAt} />. {data.lastConnectionCheck.detail}
            </p>
          )}

          <section aria-labelledby="allowlist-title">
            <h3 id="allowlist-title" className="rr-subheading">
              Sandbox receiver allowlist
            </h3>
            <p className="rr-field__hint">
              Payment actions can only reach these PayPal Sandbox test accounts (exact email match). Managed on the server with <span className="rr-mono">npm run paypal:receivers</span>.
            </p>
            {data.allowlist.length === 0 ? (
              <p className="rr-muted rr-section-gap">The allowlist is empty, so no reissue can be approved.</p>
            ) : (
              <ul role="list" className="rr-plain-list">
                {data.allowlist.map((e) => (
                  <li key={e.receiverMasked + e.addedAt}>
                    {e.receiverMasked} · {e.label} · {e.active ? 'active' : 'deactivated'}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="limits-title">
            <h3 id="limits-title" className="rr-subheading">
              Limits
            </h3>
            <ul role="list" className="rr-plain-list">
              <li>Currencies: {data.limits.currencies.join(', ')}</li>
              <li>Maximum per payout: {data.limits.currencies.map((c) => formatMoneyValue({ currency: c, minor: data.limits.maxPerPayoutMinor })).join(' / ')}</li>
              <li>At most {data.limits.maxPayoutsPerDay} payouts per organisation per day</li>
              <li>At most {data.limits.currencies.map((c) => formatMoneyValue({ currency: c, minor: data.limits.maxValuePerCurrencyPerDayMinor })).join(' / ')} per currency per day</li>
              <li>Proposals expire after {data.limits.proposalExpiryHours} hours</li>
              <li>At most {data.limits.maxRecoveryAttempts} recovery attempts per payment</li>
            </ul>
          </section>

          <section aria-labelledby="webhooks-title">
            <h3 id="webhooks-title" className="rr-subheading">
              Recent webhook deliveries
            </h3>
            {data.webhook.recent.length === 0 ? (
              <p className="rr-muted">No deliveries received.</p>
            ) : (
              <div className="rr-table-scroll rr-table-scroll--boxed" role="region" aria-label="Recent webhook deliveries" tabIndex={0}>
                <table className="rr-table rr-table--compact">
                  <thead>
                    <tr>
                      <th scope="col">Received</th>
                      <th scope="col">Event</th>
                      <th scope="col">Verification</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.webhook.recent.map((w) => (
                      <tr key={w.seq}>
                        <td>
                          <DateTime value={w.receivedAt} />
                        </td>
                        <td className="rr-mono">{w.eventType ?? '—'}</td>
                        <td>
                          {w.verification === 'failed' ? (
                            <Badge tone="critical" icon={CircleX} size="sm" label={`Failed: ${w.failureCode ?? 'unknown'}`} />
                          ) : (
                            <Badge tone="success" icon={CircleCheck} size="sm" label={w.verification === 'duplicate' ? 'Verified duplicate' : 'Verified'} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </Panel>
  );
}

export function SettingsPage() {
  useDocumentTitle('Settings');
  const { data: session } = useSession();
  return (
    <div className="rr-page">
      <PageHeader title="Settings" description="Organisation, roles and integration status. Secrets are never displayed." />
      <div className="rr-two-column">
        <div className="rr-stack">
          <PayPalPanel />
        </div>
        <div className="rr-stack">
          {session && (
            <>
              <Panel title="Organisation and session">
                <dl className="rr-facts">
                  <Fact label="Organisation">
                    {session.organisation.name}
                    {session.organisation.isSynthetic ? ' (synthetic demo data)' : ''}
                  </Fact>
                  <Fact label="Signed in as">
                    {session.user.displayName}, {ROLE_LABEL[session.user.role]}
                  </Fact>
                  <Fact label="Authentication">
                    {session.environment.judgeDemo
                      ? 'Public Judge Demo: server-signed demo identities (operator, approver or viewer; never administrator). Not authentication.'
                      : `Demo session${session.environment.demoRoleSwitcher ? ' with the development-only role demonstration switcher (not authentication)' : ''}`}
                  </Fact>
                </dl>
              </Panel>
              <Panel title="Environment">
                <dl className="rr-facts">
                  <Fact label="AI investigation">
                    <YesNo value={session.environment.ai.configured} yes="Configured" no="Not configured" />
                    <span className="rr-table__secondary">{session.environment.ai.detail}</span>
                  </Fact>
                  <Fact label="PayPal">
                    <YesNo value={session.environment.paypal.configured} yes="Configured" no="Not configured" />
                    <span className="rr-table__secondary">{session.environment.paypal.detail}</span>
                  </Fact>
                  <Fact label="Database">
                    <YesNo value={session.environment.database.configured} yes="Connected" no="Unavailable" />
                    <span className="rr-table__secondary">{session.environment.database.detail}</span>
                  </Fact>
                  <Fact label="Version">
                    <span className="rr-mono">{session.environment.version}</span>
                  </Fact>
                </dl>
              </Panel>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
