import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPayoutCurrency, PAYPAL_TARGET_INFO } from '@shared/domain/payouts';
import { loadConfig, loadDotEnv } from '../config/env';
import { openDatabase, type Db } from '../db/connection';
import { runMigrations } from '../db/migrate';
import { addEntry, deactivateEntry, listEntries } from '../payouts/allowlist';
import { createDemoScenario } from '../payouts/demoScenario';
import { DEMO_SESSION_USER_ID } from '../seed/syntheticDataset';
import { createPayPalClient } from './client';

const USAGE = `Usage:
  npm run paypal:receivers -- list
  npm run paypal:receivers -- add <email> --label "<label>"
  npm run paypal:receivers -- deactivate <email> --reason "<reason>"
  npm run paypal:sandbox-check [-- --negative]
  npm run sandbox:demo-scenario -- --receiver <email> [--amount 12.50] [--currency GBP]
  npm run paypal:webhook-fixture -- <capture file>`;

export const GENUINE_FIXTURE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'genuine-sandbox-webhook.json');

/** PayPal's documented Sandbox mock item IDs for cancellation negative testing. They never move money. */
const NEGATIVE_CANCEL_IDS = ['POSPOI002', 'ERRPOI001', 'ERRPYO004', 'ERRPYO007', 'ERRPYO008', 'ERRPYO009'];

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function organisationOf(db: Db): string {
  const row = db.prepare('SELECT organisation_id FROM users WHERE id = ?').get(DEMO_SESSION_USER_ID) as { organisation_id: string } | undefined;
  if (!row) throw new Error('The demo organisation does not exist. Run npm run db:reset first.');
  return row.organisation_id;
}

async function main(args: string[]): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  const [group, ...rest] = args;

  if (group === 'receivers') {
    const [command, email] = rest;
    const db = openDatabase(config.databasePath);
    try {
      runMigrations(db);
      const org = organisationOf(db);
      if (command === 'list') {
        const entries = listEntries(db, org);
        if (entries.length === 0) console.log('The Sandbox receiver allowlist is empty.');
        for (const e of entries) console.log(`${e.deactivated_at ? 'inactive' : 'active  '}  ${e.receiver_value}  "${e.label}"  added ${e.added_at}`);
        return 0;
      }
      if (command === 'add' && email) {
        const label = option(rest, '--label');
        if (!label) throw new Error('Give a label with --label "<label>".');
        const entry = addEntry(db, org, email, label, new Date());
        console.log(`Added ${entry.receiver_value} to the Sandbox receiver allowlist.`);
        return 0;
      }
      if (command === 'deactivate' && email) {
        const reason = option(rest, '--reason');
        if (!reason) throw new Error('Give a reason with --reason "<reason>".');
        deactivateEntry(db, org, email, reason, new Date());
        console.log(`Deactivated ${email.trim().toLowerCase()}. Payment actions can no longer reach it.`);
        return 0;
      }
    } finally {
      db.close();
    }
  }

  if (group === 'sandbox-check') {
    if (!config.paypal.clientId || !config.paypal.clientSecret) {
      console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (from a PayPal Sandbox app) in .env first.');
      return 1;
    }
    const client = createPayPalClient({ baseUrl: config.paypal.apiBaseUrl, clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret });
    console.log(`PayPal API host: ${new URL(config.paypal.apiBaseUrl).host}`);
    if (config.paypal.target === 'local_stub') console.log(PAYPAL_TARGET_INFO.local_stub.notice);
    const token = await client.checkCredentials();
    if (!token.ok) {
      console.error(`Token request refused: ${token.name ?? (token.status === null ? 'no response' : `HTTP ${token.status}`)}`);
      return 2;
    }
    console.log('Token request: accepted (the token itself is never printed).');
    console.log(`Payouts scope granted: ${token.scopes.includes('https://uri.paypal.com/payments/payouts') ? 'yes' : 'NO - enable Payouts for this Sandbox app'}`);
    const probe = await client.getBatch('RRCHECKDOESNOTEXIST');
    console.log(`Read of a non-existent batch: ${probe.ok ? `unexpected HTTP ${probe.status}` : `HTTP ${probe.status ?? 'no response'} ${probe.name ?? ''} (expected 404)`}`);
    if (rest.includes('--negative')) {
      console.log('Negative tests: cancelling PayPal-documented mock item IDs (no money moves).');
      for (const id of NEGATIVE_CANCEL_IDS) {
        const result = await client.cancelItem(id);
        console.log(`  ${id}: ${result.ok ? `HTTP ${result.status}` : `HTTP ${result.status ?? 'no response'} ${result.name ?? ''}`}`);
      }
    }
    return 0;
  }

  if (group === 'demo-scenario') {
    if (config.nodeEnv !== 'development') {
      console.error('sandbox:demo-scenario only runs with NODE_ENV=development.');
      return 1;
    }
    const receiver = option(rest, '--receiver');
    if (!receiver) throw new Error('Give an allowlisted receiver with --receiver <email>.');
    const amountText = option(rest, '--amount') ?? '12.50';
    const match = /^(\d{1,3})(?:\.(\d{2}))?$/.exec(amountText);
    if (!match) throw new Error('The amount must look like 12.50.');
    const currency = (option(rest, '--currency') ?? 'GBP').toUpperCase();
    if (!isPayoutCurrency(currency)) throw new Error('The currency must be GBP, USD or EUR.');
    const db = openDatabase(config.databasePath);
    try {
      runMigrations(db);
      const result = createDemoScenario(db, {
        organisationId: organisationOf(db),
        receiver,
        amountMinor: Number(match[1]) * 100 + Number(match[2] ?? '0'),
        currency,
        now: new Date(),
      });
      console.log(`Created case ${result.caseReference} for simulated payment ${result.paymentReference} (batch ${result.batchReference}).`);
      console.log('The original payment and its RETURNED status are simulated; nothing was sent to PayPal.');
      console.log(
        config.paypal.target === 'local_stub'
          ? 'PAYPAL_API_BASE_URL points at a local stub: a reissue approved on this case is answered locally and is not a PayPal Sandbox payout.'
          : 'To create a genuine PayPal Sandbox recovery payout: propose a reissue on the case as an operator, then approve it as a different approver.',
      );
      return 0;
    } finally {
      db.close();
    }
  }

  if (group === 'webhook-fixture') {
    const file = rest[0];
    if (!file) throw new Error('Give the path of a captured webhook delivery.');
    if (!config.paypal.webhookId) throw new Error('PAYPAL_WEBHOOK_ID must be set to the webhook the capture was sent to.');
    const capture = JSON.parse(readFileSync(file, 'utf8')) as { capturedAt: string; verification: string; headers: Record<string, string>; bodyBase64: string; certPem: string | null };
    if (capture.verification !== 'verified' || !capture.certPem) {
      console.error('Only a delivery that verified when it was received can become the fixture.');
      return 1;
    }
    mkdirSync(dirname(GENUINE_FIXTURE_PATH), { recursive: true });
    writeFileSync(
      GENUINE_FIXTURE_PATH,
      JSON.stringify(
        {
          source: 'Genuine PayPal Sandbox webhook delivery, captured by the ReliefRelay listener with its original headers and raw body.',
          capturedAt: capture.capturedAt,
          webhookId: config.paypal.webhookId,
          headers: capture.headers,
          bodyBase64: capture.bodyBase64,
          certPem: capture.certPem,
        },
        null,
        2,
      ),
    );
    console.log(`Wrote ${GENUINE_FIXTURE_PATH}`);
    return 0;
  }

  console.error(USAGE);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
