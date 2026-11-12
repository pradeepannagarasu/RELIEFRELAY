import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isLoopbackUrl, loadConfig, loadDotEnv } from '../config/env';
import { prepareDatabase } from '../db/bootstrap';
import { createLogger } from '../lib/logger';
import { addEntry } from '../payouts/allowlist';
import { createDemoScenario } from '../payouts/demoScenario';
import { DEMO_SESSION_USER_ID } from '../seed/syntheticDataset';
import { startPayPalStub } from '../test-support/paypalStub';

/**
 * Development-only demonstration of the payment actions without PayPal credentials. It starts the local PayPal stub
 * on a loopback address and runs the API against it, on a separate, disposable database. Every PayPal setting from
 * .env is replaced, so no PayPal host is called and real credentials are never sent to the stub.
 */

export const LOCAL_STUB_DEMO_DATABASE = 'server/data/local-stub-demo.db';
export const LOCAL_STUB_DEMO_RECEIVER = 'demo.receiver@personal.example.com';
const STUB_CLIENT_ID = 'local-stub-client-id';
const STUB_CLIENT_SECRET = 'local-stub-client-secret';

/** An unset NODE_ENV means development, as in loadConfig. */
export function assertLocalStubDemoAllowed(env: NodeJS.ProcessEnv): void {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (nodeEnv !== 'development') {
    throw new Error(`The local PayPal stub demonstration only runs with NODE_ENV=development (found ${nodeEnv}).`);
  }
}

/**
 * Overrides applied on top of the environment. AI investigation is switched off because the evidence pack would
 * describe stub records as PayPal Sandbox records.
 */
export function localStubDemoEnv(stubBaseUrl: string): Record<string, string> {
  if (!isLoopbackUrl(stubBaseUrl)) throw new Error('The local PayPal stub must run on a loopback address.');
  return {
    NODE_ENV: 'development',
    PAYMENT_PROVIDER_MODE: 'sandbox',
    PAYPAL_API_BASE_URL: stubBaseUrl,
    PAYPAL_CLIENT_ID: STUB_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: STUB_CLIENT_SECRET,
    PAYPAL_PAYOUTS_ENABLED: 'true',
    PAYPAL_WEBHOOK_ID: '',
    PAYPAL_WEBHOOK_CAPTURE_DIR: '',
    DEMO_ROLE_SWITCHER: 'true',
    OPENAI_API_KEY: '',
    DATABASE_PATH: LOCAL_STUB_DEMO_DATABASE,
  };
}

async function main(): Promise<void> {
  loadDotEnv();
  assertLocalStubDemoAllowed(process.env);
  const stub = await startPayPalStub({ clientId: STUB_CLIENT_ID, clientSecret: STUB_CLIENT_SECRET });
  Object.assign(process.env, localStubDemoEnv(stub.baseUrl));
  const config = loadConfig();
  if (config.paypal.target !== 'local_stub' || !isLoopbackUrl(config.paypal.apiBaseUrl)) {
    throw new Error('Refusing to start: the PayPal API is not the local stub.');
  }

  // The stub keeps its payouts in memory, so the demonstration database starts empty on every run to match it.
  const path = resolve(LOCAL_STUB_DEMO_DATABASE);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (existsSync(path + suffix)) rmSync(path + suffix);
  }
  const db = prepareDatabase(config, createLogger(config));
  let caseReference: string;
  try {
    const { organisation_id: org } = db.prepare('SELECT organisation_id FROM users WHERE id = ?').get(DEMO_SESSION_USER_ID) as { organisation_id: string };
    const now = new Date();
    addEntry(db, org, LOCAL_STUB_DEMO_RECEIVER, 'Local stub demonstration receiver (synthetic)', now);
    caseReference = createDemoScenario(db, { organisationId: org, receiver: LOCAL_STUB_DEMO_RECEIVER, amountMinor: 1250, currency: 'GBP', now }).caseReference;
  } finally {
    db.close();
  }

  console.log(
    [
      '',
      '=== LOCAL PAYPAL STUB DEMONSTRATION (test only) ===',
      `PayPal requests go to a local stub at ${stub.baseUrl}. Nothing is sent to PayPal, not even PayPal Sandbox,`,
      'and no PayPal transaction exists. Every screen is labelled "Local PayPal stub".',
      `Database: ${LOCAL_STUB_DEMO_DATABASE} (recreated on every run). AI investigation is off in this demonstration.`,
      `Open http://localhost:5173/cases and find case ${caseReference} (simulated returned payment, GBP 12.50).`,
      '',
    ].join('\n'),
  );
  await import('../index');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
