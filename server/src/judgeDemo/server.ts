import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../app';
import { isLoopbackUrl, loadConfig, loadDotEnv } from '../config/env';
import { prepareDatabase } from '../db/bootstrap';
import { openDatabase } from '../db/connection';
import { createLogger } from '../lib/logger';
import { createPayoutModule } from '../payouts/module';
import { DEMO_SESSION_USER_ID } from '../seed/syntheticDataset';
import { startPayPalStub } from '../test-support/paypalStub';
import { createIdentitySigner, JUDGE_ROLES } from './identity';
import { decideJudgeStart, lastJudgeActivity, loadOrCreateIdentitySecret, portInUse, removeJudgeDemoFiles, restoreStubPayouts } from './persistence';
import { createJudgeScenario, JUDGE_OUTCOMES, judgeOutcomeFor, registerJudgeReceivers } from './scenarios';

/**
 * The public Judge Demo API. A separate process with its own database, kept across restarts, whose payment actions
 * go only to a local PayPal stub on a loopback address. Every PayPal setting from .env is replaced, so the genuine
 * PayPal Sandbox credentials are never used here and no PayPal host is ever called. The private API and its database
 * are not touched. Listens on 127.0.0.1 only; the public gateway in judge mode is its only client.
 */

export const JUDGE_DEMO_DATABASE = 'server/data/judge-demo.db';
export const DEFAULT_PRIVATE_DATABASE = 'server/data/reliefrelay.db';
export const JUDGE_DEMO_KEY = 'server/data/judge-demo.key';
const STUB_CLIENT_ID = 'judge-demo-stub-client-id';
const STUB_CLIENT_SECRET = 'judge-demo-stub-client-secret';

export function judgeDemoEnv(stubBaseUrl: string, source: NodeJS.ProcessEnv): Record<string, string> {
  if (!isLoopbackUrl(stubBaseUrl)) throw new Error('The Judge Demo PayPal stub must run on a loopback address.');
  return {
    NODE_ENV: 'development',
    PORT: source.JUDGE_DEMO_PORT ?? '4100',
    PAYMENT_PROVIDER_MODE: 'sandbox',
    PAYPAL_API_BASE_URL: stubBaseUrl,
    PAYPAL_CLIENT_ID: STUB_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: STUB_CLIENT_SECRET,
    PAYPAL_PAYOUTS_ENABLED: 'true',
    PAYPAL_WEBHOOK_ID: '',
    PAYPAL_WEBHOOK_CAPTURE_DIR: '',
    PAYPAL_POLL_INTERVAL_MS: '5000',
    DEMO_ROLE_SWITCHER: 'false',
    AI_DAILY_INVESTIGATION_LIMIT: source.JUDGE_AI_DAILY_LIMIT ?? '40',
    DATABASE_PATH: JUDGE_DEMO_DATABASE,
  };
}

/** Refuses any configuration that could reach PayPal or share the private database. */
export function assertJudgeIsolation(config: ReturnType<typeof loadConfig>, privateDatabasePaths: string[]): void {
  if (config.paypal.target !== 'local_stub' || !isLoopbackUrl(config.paypal.apiBaseUrl)) {
    throw new Error('Refusing to start: the Judge Demo PayPal API is not the local stub.');
  }
  if (config.paypal.clientId !== STUB_CLIENT_ID || config.paypal.clientSecret !== STUB_CLIENT_SECRET) {
    throw new Error('Refusing to start: the Judge Demo must use stub credentials only.');
  }
  const own = resolve(config.databasePath).toLowerCase();
  if (privateDatabasePaths.some((p) => resolve(p).toLowerCase() === own)) {
    throw new Error('Refusing to start: the Judge Demo database must be separate from the private database.');
  }
}

async function main(options: { reset: boolean; force: boolean }): Promise<void> {
  loadDotEnv();
  if ((process.env.NODE_ENV ?? 'development') !== 'development') throw new Error('The Judge Demo runs with NODE_ENV=development only (it uses a local PayPal stub).');
  const privatePaths = [DEFAULT_PRIVATE_DATABASE, process.env.DATABASE_PATH ?? DEFAULT_PRIVATE_DATABASE];
  const stub = await startPayPalStub({ clientId: STUB_CLIENT_ID, clientSecret: STUB_CLIENT_SECRET, outcomeFor: judgeOutcomeFor });
  Object.assign(process.env, judgeDemoEnv(stub.baseUrl, process.env));
  const config = loadConfig();
  assertJudgeIsolation(config, privatePaths);
  const logger = createLogger(config);

  const path = resolve(JUDGE_DEMO_DATABASE);
  const keyPath = resolve(JUDGE_DEMO_KEY);
  const now = new Date();
  const exists = existsSync(path);
  let lastActivity: Date | null = null;
  if (exists && options.reset) {
    if (await portInUse(config.port)) throw new Error(`Refusing to reset: a Judge Demo API is already running on port ${config.port}. Stop it first.`);
    const existing = openDatabase(path);
    try {
      lastActivity = lastJudgeActivity(existing);
    } finally {
      existing.close();
    }
  }
  const decision = decideJudgeStart({ exists, reset: options.reset, force: options.force, lastActivity, now });
  if (decision.action === 'reset') removeJudgeDemoFiles(path, keyPath);

  const db = prepareDatabase(config, logger);
  const { organisation_id: org } = db.prepare('SELECT organisation_id FROM users WHERE id = ?').get(DEMO_SESSION_USER_ID) as { organisation_id: string };
  registerJudgeReceivers(db, org, now);
  const fresh = decision.action !== 'keep';
  const seeded = fresh ? JUDGE_OUTCOMES.map((outcome) => createJudgeScenario(db, { organisationId: org, outcome, now, requestedBy: 'Judge Demo setup' })) : [];
  const restored = fresh ? 0 : restoreStubPayouts(db, stub);

  const clock = () => new Date();
  const payouts = createPayoutModule({ db, config, clock, logger, pollPendingMs: 10_000, pollUnclaimedMs: 60_000 });
  const signer = createIdentitySigner(loadOrCreateIdentitySecret(keyPath));
  const app = createApp({ config, logger, db, demoUserId: DEMO_SESSION_USER_ID, clock, payouts, judgeDemo: { signer, roles: JUDGE_ROLES } });
  payouts.start();
  const server = app.listen(config.port, '127.0.0.1', () => {
    console.log(
      [
        '',
        '=== RELIEFRELAY JUDGE DEMO API (simulated payments) ===',
        `Listening on http://127.0.0.1:${config.port} only. Payment actions go to a local PayPal stub at ${stub.baseUrl}; nothing is sent to PayPal.`,
        fresh
          ? `Database: ${JUDGE_DEMO_DATABASE} (${decision.action === 'reset' ? 'reset on request' : 'new'}). Scenario cases: ${seeded.map((s) => `${s.caseReference} (${s.outcome})`).join(', ')}.`
          : `Database: ${JUDGE_DEMO_DATABASE} (kept from the previous run; ${restored} simulated payout${restored === 1 ? '' : 's'} restored to the stub). Reset only with npm run demo:judge:reset.`,
        'Private database untouched.',
        '',
      ].join('\n'),
    );
  });

  const shutdown = () => {
    payouts.stop();
    server.close(() => {
      db.close();
      void stub.close().then(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--reset' && a !== '--force');
  if (unknown.length > 0 || (args.includes('--force') && !args.includes('--reset'))) {
    console.error('Usage: npm run demo:judge            (keeps the Judge Demo data)\n       npm run demo:judge:reset      (fresh data; refused within 30 minutes of judge activity)\n       npm run demo:judge:reset -- --force');
    process.exit(2);
  }
  main({ reset: args.includes('--reset'), force: args.includes('--force') }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
