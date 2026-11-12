import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { createApp } from '../app';
import { loadConfig } from '../config/env';
import { addEntry } from '../payouts/allowlist';
import { createDemoScenario } from '../payouts/demoScenario';
import { createPayoutModule, type PayoutModule } from '../payouts/module';
import type { CertFetcher } from '../paypal/webhookVerifier';
import { createSeededDatabase, TEST_NOW } from './seededApp';
import { startPayPalStub, type PayPalStub, type PayPalStubOptions } from './paypalStub';
import type { TempDatabase } from './tempDb';

export const SANDBOX_RECEIVER = 'sb-demo-recipient@personal.example.com';
export const ORG = 'org_demo';
export const OPERATOR = 'usr_lena';
export const APPROVER = 'usr_samuel';
export const ADMIN = 'usr_priya';
export const VIEWER = 'usr_tomas';

export interface SandboxHarness {
  stub: PayPalStub;
  temp: TempDatabase;
  payouts: PayoutModule;
  now(): Date;
  setNow(date: Date): void;
  advance(ms: number): void;
  base(userId: string): string;
  /** A new demo-scenario case for the allowlisted receiver. */
  scenario(amountMinor?: number, currency?: 'GBP' | 'USD' | 'EUR'): ReturnType<typeof createDemoScenario>;
  close(): Promise<void>;
}

export async function startSandboxHarness(
  options: { env?: NodeJS.ProcessEnv; fetchCert?: CertFetcher; start?: Date; allowlist?: boolean; outcomeFor?: PayPalStubOptions['outcomeFor'] } = {},
): Promise<SandboxHarness> {
  let now = new Date(options.start ?? TEST_NOW);
  const clock = () => now;
  const stub = await startPayPalStub({ outcomeFor: options.outcomeFor, now: () => now.getTime() });
  const temp = createSeededDatabase();
  if (options.allowlist !== false) addEntry(temp.db, ORG, SANDBOX_RECEIVER, 'Sandbox personal test account', now);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: temp.path,
    PAYMENT_PROVIDER_MODE: 'sandbox',
    PAYPAL_CLIENT_ID: 'stub-client-id',
    PAYPAL_CLIENT_SECRET: 'stub-client-secret',
    PAYPAL_API_BASE_URL: stub.baseUrl,
    PAYPAL_PAYOUTS_ENABLED: 'true',
    PAYPAL_WEBHOOK_ID: 'WH-TEST-0001',
    ...options.env,
  });
  const logger = pino({ level: 'silent' });
  const payouts = createPayoutModule({ db: temp.db, config, clock, logger, sleep: async () => undefined, fetchCert: options.fetchCert });
  const servers = new Map<string, { server: Server; base: string }>();
  for (const userId of [OPERATOR, APPROVER, ADMIN, VIEWER]) {
    const app = createApp({ config, logger, db: temp.db, demoUserId: userId, clock, payouts, aiProvider: null });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    servers.set(userId, { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` });
  }
  return {
    stub,
    temp,
    payouts,
    now: () => now,
    setNow: (date) => {
      now = new Date(date);
    },
    advance: (ms) => {
      now = new Date(now.getTime() + ms);
    },
    base: (userId) => servers.get(userId)!.base,
    scenario: (amountMinor = 1250, currency = 'GBP') => createDemoScenario(temp.db, { organisationId: ORG, receiver: SANDBOX_RECEIVER, amountMinor, currency, now }),
    close: async () => {
      payouts.stop();
      for (const { server } of servers.values()) await new Promise<void>((resolve) => server.close(() => resolve()));
      await stub.close();
      temp.cleanup();
    },
  };
}

export const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
