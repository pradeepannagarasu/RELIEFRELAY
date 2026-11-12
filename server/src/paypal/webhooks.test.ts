import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { PaymentActionsResponse, ProposalDetail, ProposalResponse } from '@shared/api/contracts';
import type { Db } from '../db/connection';
import { TEST_WEBHOOK_CERT_PEM, TEST_WEBHOOK_KEY_PEM } from '../test-support/paypalTestCert';
import { APPROVER, OPERATOR, post, startSandboxHarness, type SandboxHarness } from '../test-support/sandboxHarness';
import { createWebhookApp, WEBHOOK_PATH } from './webhookServer';
import { createWebhookVerifier, validateCertUrl, webhookSigningString, type CertFetcher, type WebhookHeaders } from './webhookVerifier';

/** The test certificate is valid from 11 Nov 2026 13:20 GMT, so every signed delivery here uses a later clock. */
const NOW = new Date('2027-01-01T12:00:00.000Z');
const WEBHOOK_ID = 'WH-TEST-0001';
const CERT_URL = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-test';
const GENUINE_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'genuine-sandbox-webhook.json');

function signedHeaders(body: Buffer, overrides: Partial<WebhookHeaders> & { webhookId?: string } = {}): WebhookHeaders {
  const transmissionId = overrides.transmissionId ?? `tx-${Math.random().toString(16).slice(2)}`;
  const transmissionTime = overrides.transmissionTime ?? NOW.toISOString();
  const message = `${transmissionId}|${transmissionTime}|${overrides.webhookId ?? WEBHOOK_ID}|${crc32(body) >>> 0}`;
  return {
    transmissionId,
    transmissionTime,
    transmissionSig: overrides.transmissionSig ?? sign('sha256', Buffer.from(message), TEST_WEBHOOK_KEY_PEM).toString('base64'),
    certUrl: overrides.certUrl ?? CERT_URL,
    authAlgo: overrides.authAlgo ?? 'SHA256withRSA',
  };
}

const httpHeaders = (h: WebhookHeaders): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(h.transmissionId ? { 'paypal-transmission-id': h.transmissionId } : {}),
  ...(h.transmissionTime ? { 'paypal-transmission-time': h.transmissionTime } : {}),
  ...(h.transmissionSig ? { 'paypal-transmission-sig': h.transmissionSig } : {}),
  ...(h.certUrl ? { 'paypal-cert-url': h.certUrl } : {}),
  ...(h.authAlgo ? { 'paypal-auth-algo': h.authAlgo } : {}),
});

function countingFetcher(pem = TEST_WEBHOOK_CERT_PEM) {
  const urls: string[] = [];
  const fetchCert: CertFetcher = async (url) => {
    urls.push(url);
    return pem;
  };
  return { urls, fetchCert };
}

const itemEvent = (eventId: string, itemId: string, batchId: string, payloadStatus = 'SUCCESS') =>
  Buffer.from(
    JSON.stringify({
      id: eventId,
      event_version: '1.0',
      create_time: NOW.toISOString(),
      resource_type: 'payouts_item',
      event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
      summary: 'A payout item has succeeded',
      resource: { payout_item_id: itemId, payout_batch_id: batchId, transaction_status: payloadStatus },
    }),
  );

describe('webhook certificate URL rules', () => {
  it('accepts only the PayPal Sandbox certificate endpoints', () => {
    expect(validateCertUrl(CERT_URL).ok).toBe(true);
    expect(validateCertUrl('https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-abc').ok).toBe(true);
    for (const bad of [
      undefined,
      '',
      'http://api.sandbox.paypal.com/v1/notifications/certs/CERT-abc',
      'https://api.paypal.com/v1/notifications/certs/CERT-abc',
      'https://api-m.paypal.com/v1/notifications/certs/CERT-abc',
      'https://api.sandbox.paypal.com.attacker.example/v1/notifications/certs/CERT-abc',
      'https://attacker.example/api.sandbox.paypal.com/v1/notifications/certs/CERT-abc',
      'https://api.sandbox.paypal.com:8443/v1/notifications/certs/CERT-abc',
      'https://user:pass@api.sandbox.paypal.com/v1/notifications/certs/CERT-abc',
      'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-abc?next=https://attacker.example',
      'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-abc#x',
      'https://api.sandbox.paypal.com/v1/notifications/certs/../../oauth2/token',
      'https://api.sandbox.paypal.com/v1/notifications/certs/%2e%2e/token',
      'https://api.sandbox.paypal.com/v1/notifications/other/CERT-abc',
      'https://api.sandbox.paypal.com\\@attacker.example/v1/notifications/certs/CERT-abc',
      'file:///etc/passwd',
    ]) {
      expect(validateCertUrl(bad).ok, String(bad)).toBe(false);
    }
  });
});

/** Bitwise CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320), written independently of node:zlib. */
function referenceCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('webhook signing string (independent vectors)', () => {
  it('uses the unsigned CRC32 of the exact raw body, checked against the published CRC-32 test vector', () => {
    // CRC-32 of "123456789" is 0xCBF43926 = 3421780262. Its high bit is set, so a signed value would be -873187034.
    expect(webhookSigningString('tx-1', '2027-01-01T12:00:00Z', 'WH-1', Buffer.from('123456789', 'ascii'))).toBe('tx-1|2027-01-01T12:00:00Z|WH-1|3421780262');
    expect(webhookSigningString('a', 'b', 'c', Buffer.alloc(0))).toBe('a|b|c|0');
  });

  it('matches an independent CRC32 over non-ASCII, binary and whitespace-sensitive bodies', () => {
    const bodies = [
      Buffer.from('{"note":"£12.50 – café, 日本"}', 'utf8'),
      Buffer.from('{"a":1}\n', 'utf8'),
      Buffer.from('{"a":1}\r\n', 'utf8'),
      Buffer.from([0x00, 0xff, 0x80, 0x7f, 0xfe, 0x01]),
      itemEvent('WH-EVT-CRC', 'ITEMIDCRC', 'BATCHIDCRC'),
    ];
    for (const body of bodies) {
      expect(webhookSigningString('t', 'u', 'w', body)).toBe(`t|u|w|${referenceCrc32(body)}`);
    }
    expect(referenceCrc32(Buffer.from('123456789'))).toBe(3421780262);
  });

  it('verifies a signature made over a hand-written signing string, and refuses one made over a signed CRC', async () => {
    const body = Buffer.from('123456789', 'ascii');
    const headersFor = (message: string): WebhookHeaders => ({
      transmissionId: 'tx-literal',
      transmissionTime: '2027-01-01T12:00:00.000Z',
      transmissionSig: sign('sha256', Buffer.from(message, 'utf8'), TEST_WEBHOOK_KEY_PEM).toString('base64'),
      certUrl: CERT_URL,
      authAlgo: 'SHA256withRSA',
    });
    const verify = createWebhookVerifier({ webhookId: WEBHOOK_ID, fetchCert: countingFetcher().fetchCert, clock: () => NOW });
    await expect(verify(body, headersFor('tx-literal|2027-01-01T12:00:00.000Z|WH-TEST-0001|3421780262'))).resolves.toMatchObject({ ok: true });
    await expect(verify(body, headersFor('tx-literal|2027-01-01T12:00:00.000Z|WH-TEST-0001|-873187034'))).resolves.toMatchObject({ ok: false, code: 'signature_invalid' });
    await expect(verify(body, headersFor('tx-literal|2027-01-01T12:00:00.000Z|WH-TEST-0001|cbf43926'))).resolves.toMatchObject({ ok: false, code: 'signature_invalid' });
  });

  it('refuses a correct signing string signed by a key other than the certificate’s', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const body = Buffer.from('123456789', 'ascii');
    const message = 'tx-other|2027-01-01T12:00:00.000Z|WH-TEST-0001|3421780262';
    const verify = createWebhookVerifier({ webhookId: WEBHOOK_ID, fetchCert: countingFetcher().fetchCert, clock: () => NOW });
    const headers: WebhookHeaders = {
      transmissionId: 'tx-other',
      transmissionTime: '2027-01-01T12:00:00.000Z',
      transmissionSig: sign('sha256', Buffer.from(message, 'utf8'), privateKey).toString('base64'),
      certUrl: CERT_URL,
      authAlgo: 'SHA256withRSA',
    };
    await expect(verify(body, headers)).resolves.toMatchObject({ ok: false, code: 'signature_invalid' });
  });
});

describe('webhook signature verification (local test certificate)', () => {
  const body = itemEvent('WH-EVT-1', 'ITEMID0001', 'BATCHID0001');

  it('verifies the raw body and refuses a single changed byte', async () => {
    const { fetchCert } = countingFetcher();
    const verify = createWebhookVerifier({ webhookId: WEBHOOK_ID, fetchCert, clock: () => NOW });
    const headers = signedHeaders(body);
    await expect(verify(body, headers)).resolves.toMatchObject({ ok: true, certHost: 'api.sandbox.paypal.com' });

    const tampered = Buffer.from(body);
    tampered[tampered.length - 3] = tampered[tampered.length - 3]! ^ 0x01;
    await expect(verify(tampered, headers)).resolves.toMatchObject({ ok: false, code: 'signature_invalid' });

    // Re-serialising the same JSON with different spacing is a different body and must not verify.
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1));
    await expect(verify(reserialised, headers)).resolves.toMatchObject({ ok: false, code: 'signature_invalid' });
  });

  it('refuses a signature made for another webhook ID', async () => {
    const verify = createWebhookVerifier({ webhookId: WEBHOOK_ID, fetchCert: countingFetcher().fetchCert, clock: () => NOW });
    await expect(verify(body, signedHeaders(body, { webhookId: 'WH-OTHER' }))).resolves.toMatchObject({ ok: false, code: 'signature_invalid' });
  });

  it('enforces the transmission time window', async () => {
    const verify = createWebhookVerifier({ webhookId: WEBHOOK_ID, fetchCert: countingFetcher().fetchCert, clock: () => NOW });
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    await expect(verify(body, signedHeaders(body, { transmissionTime: at(4 * 60_000) }))).resolves.toMatchObject({ ok: true });
    await expect(verify(body, signedHeaders(body, { transmissionTime: at(6 * 60_000) }))).resolves.toMatchObject({ ok: false, code: 'transmission_in_future' });
    await expect(verify(body, signedHeaders(body, { transmissionTime: at(-3 * 86_400_000) }))).resolves.toMatchObject({ ok: true });
    await expect(verify(body, signedHeaders(body, { transmissionTime: at(-5 * 86_400_000) }))).resolves.toMatchObject({ ok: false, code: 'transmission_too_old' });
    await expect(verify(body, signedHeaders(body, { transmissionTime: 'yesterday' }))).resolves.toMatchObject({ ok: false, code: 'invalid_transmission_time' });
  });

  it('refuses missing headers, other algorithms, bad certificate URLs and a missing webhook ID before fetching anything', async () => {
    const { urls, fetchCert } = countingFetcher();
    const verify = createWebhookVerifier({ webhookId: WEBHOOK_ID, fetchCert, clock: () => NOW });
    const good = signedHeaders(body);
    await expect(verify(body, { ...good, transmissionSig: undefined })).resolves.toMatchObject({ ok: false, code: 'missing_headers' });
    await expect(verify(body, { ...good, authAlgo: 'SHA1withRSA' })).resolves.toMatchObject({ ok: false, code: 'unsupported_algorithm' });
    await expect(verify(body, { ...good, certUrl: 'https://attacker.example/v1/notifications/certs/CERT-abc' })).resolves.toMatchObject({ ok: false, code: 'cert_url_invalid' });
    const noId = createWebhookVerifier({ webhookId: undefined, fetchCert, clock: () => NOW });
    await expect(noId(body, good)).resolves.toMatchObject({ ok: false, code: 'webhook_id_missing' });
    expect(urls).toEqual([]);
  });

  it('handles certificate fetch failures, invalid certificates and certificate validity dates', async () => {
    const failing = createWebhookVerifier({
      webhookId: WEBHOOK_ID,
      fetchCert: async () => {
        throw new Error('timeout');
      },
      clock: () => NOW,
    });
    await expect(failing(body, signedHeaders(body))).resolves.toMatchObject({ ok: false, code: 'cert_fetch_failed', certHost: 'api.sandbox.paypal.com' });

    const garbage = createWebhookVerifier({ webhookId: WEBHOOK_ID, fetchCert: countingFetcher('not a certificate').fetchCert, clock: () => NOW });
    await expect(garbage(body, signedHeaders(body))).resolves.toMatchObject({ ok: false, code: 'cert_invalid' });

    const early = new Date('2026-11-10T12:00:00.000Z');
    const beforeValid = createWebhookVerifier({ webhookId: WEBHOOK_ID, fetchCert: countingFetcher().fetchCert, clock: () => early });
    await expect(beforeValid(body, signedHeaders(body, { transmissionTime: early.toISOString() }))).resolves.toMatchObject({ ok: false, code: 'cert_expired' });
  });

  it('caches a certificate for its URL', async () => {
    const { urls, fetchCert } = countingFetcher();
    const verify = createWebhookVerifier({ webhookId: WEBHOOK_ID, fetchCert, clock: () => NOW });
    await verify(body, signedHeaders(body));
    await verify(body, signedHeaders(body));
    expect(urls).toEqual([CERT_URL]);
  });
});

describe('webhook listener acknowledgement and processing (local stub)', () => {
  let h: SandboxHarness | undefined;
  let listener: Server | undefined;
  let captureDir: string | undefined;
  afterEach(async () => {
    if (listener) await new Promise<void>((r) => listener!.close(() => r()));
    listener = undefined;
    await h?.close();
    h = undefined;
    if (captureDir) rmSync(captureDir, { recursive: true, force: true });
    captureDir = undefined;
  });

  async function listen(db: Db, verify = h!.payouts.verifyWebhook, options: { captureDir?: string } = {}) {
    const app = createWebhookApp({ db, verify, logger: pino({ level: 'silent' }), clock: () => h?.now() ?? NOW, ...options });
    listener = app.listen(0);
    await new Promise<void>((r) => listener!.once('listening', r));
    return `http://127.0.0.1:${(listener.address() as AddressInfo).port}${WEBHOOK_PATH}`;
  }

  const deliver = (url: string, body: Buffer, headers: WebhookHeaders) => fetch(url, { method: 'POST', headers: httpHeaders(headers), body });

  /** A demo-scenario case with an accepted Sandbox recovery payout, through the real proposal and approval routes. */
  async function acceptedRecovery() {
    const scenario = h!.scenario();
    const actions = (await (await fetch(`${h!.base(OPERATOR)}/cases/${scenario.caseId}/payment-actions`)).json()) as PaymentActionsResponse;
    const created = await post(`${h!.base(OPERATOR)}/cases/${scenario.caseId}/proposals`, {
      action: 'reissue',
      reasonCode: 'returned_unclaimed',
      justification: 'Provider confirmed the payment was returned; the programme team asked for one reissue.',
      attestation: true,
      caseVersion: actions.case.version,
      providerFingerprint: actions.providerFingerprint,
    });
    const proposal = ((await created.json()) as ProposalResponse).proposal;
    const detail = ((await (await fetch(`${h!.base(APPROVER)}/proposals/${proposal.id}`)).json()) as ProposalResponse).proposal;
    const approved = await post(`${h!.base(APPROVER)}/proposals/${proposal.id}/approve`, { proposalVersion: detail.version, confirmation: detail.confirmationPhrase });
    expect(approved.status).toBe(200);
    const sub = h!.temp.db.prepare("SELECT s.provider_batch_id, si.provider_item_id, si.recovery_item_id FROM payout_submissions s JOIN payout_submission_items si ON si.submission_id = s.id WHERE s.proposal_id = ?").get(proposal.id) as {
      provider_batch_id: string;
      provider_item_id: string;
      recovery_item_id: string;
    };
    return { scenario, proposal: ((await approved.json()) as ProposalResponse).proposal as ProposalDetail, ...sub };
  }

  const transmissions = () => h!.temp.db.prepare('SELECT transmission_id, event_id, verification, failure_code FROM paypal_webhook_transmissions ORDER BY seq').all();

  it('acknowledges verified (200) and duplicate deliveries (200), refuses failed verification (400), and records every transmission', async () => {
    const { fetchCert } = countingFetcher();
    h = await startSandboxHarness({ start: NOW, fetchCert });
    const url = await listen(h.temp.db);
    const body = itemEvent('WH-EVT-ACK', 'UNKNOWNITEM1', 'UNKNOWNBATCH1');
    const headers = signedHeaders(body, { transmissionId: 'tx-ack-1' });

    expect((await deliver(url, body, headers)).status).toBe(200);
    // PayPal redelivers the same transmission after a timeout: acknowledged, recorded, not stored twice.
    expect((await deliver(url, body, headers)).status).toBe(200);
    // A new transmission of the same event (a PayPal retry or resend): acknowledged, one event row.
    expect((await deliver(url, body, signedHeaders(body, { transmissionId: 'tx-ack-2' }))).status).toBe(200);
    const tampered = Buffer.from(body.toString().replace('UNKNOWNITEM1', 'UNKNOWNITEM2'));
    expect((await deliver(url, tampered, signedHeaders(body, { transmissionId: 'tx-ack-3' }))).status).toBe(400);
    expect((await deliver(url, body, { ...headers, transmissionId: undefined })).status).toBe(400);

    expect(transmissions()).toEqual([
      { transmission_id: 'tx-ack-1', event_id: 'WH-EVT-ACK', verification: 'verified', failure_code: null },
      { transmission_id: 'tx-ack-1', event_id: 'WH-EVT-ACK', verification: 'duplicate', failure_code: null },
      { transmission_id: 'tx-ack-2', event_id: 'WH-EVT-ACK', verification: 'verified', failure_code: null },
      { transmission_id: 'tx-ack-3', event_id: null, verification: 'failed', failure_code: 'signature_invalid' },
      { transmission_id: null, event_id: null, verification: 'failed', failure_code: 'missing_headers' },
    ]);
    expect(h.temp.db.prepare('SELECT event_id, provider_item_id, processing_state FROM paypal_webhook_events').all()).toEqual([
      { event_id: 'WH-EVT-ACK', provider_item_id: 'UNKNOWNITEM1', processing_state: 'pending' },
    ]);
    // An event for an item ReliefRelay never created is ignored, and nothing is sent to PayPal.
    await h.payouts.webhookProcessor.processPending();
    expect(h.temp.db.prepare('SELECT processing_state FROM paypal_webhook_events').get()).toEqual({ processing_state: 'ignored' });
    expect(h.stub.count('create')).toBe(0);
  });

  it('answers 503 when a verified delivery cannot be stored, so PayPal retries it', async () => {
    h = await startSandboxHarness({ start: NOW, fetchCert: countingFetcher().fetchCert });
    const failingDb = {
      transaction: () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
    } as unknown as Db;
    const url = await listen(failingDb);
    const body = itemEvent('WH-EVT-503', 'ITEM503', 'BATCH503');
    const res = await deliver(url, body, signedHeaders(body));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
  });

  it('refuses oversized and non-webhook requests without storing them', async () => {
    h = await startSandboxHarness({ start: NOW, fetchCert: countingFetcher().fetchCert });
    const url = await listen(h.temp.db);
    const big = Buffer.alloc(70 * 1024, 0x20);
    expect((await deliver(url, big, signedHeaders(big))).status).toBe(413);
    expect((await fetch(url.replace(WEBHOOK_PATH, '/other'), { method: 'POST' })).status).toBe(404);
    expect(transmissions()).toEqual([]);
  });

  it('never applies the payload status: a SUCCESS event is checked against PayPal, which still says UNCLAIMED', async () => {
    h = await startSandboxHarness({ start: NOW, fetchCert: countingFetcher().fetchCert });
    const url = await listen(h.temp.db);
    const { scenario, provider_item_id, provider_batch_id, recovery_item_id } = await acceptedRecovery();
    const getsBefore = h.stub.count('get_item');

    const body = itemEvent('WH-EVT-LIE', provider_item_id, provider_batch_id, 'SUCCESS');
    expect((await deliver(url, body, signedHeaders(body))).status).toBe(200);
    await h.payouts.webhookProcessor.processPending();

    expect(h.stub.count('get_item')).toBe(getsBefore + 1);
    expect(h.temp.db.prepare('SELECT status, mode FROM provider_transactions WHERE payment_item_id = ?').get(recovery_item_id)).toEqual({ status: 'UNCLAIMED', mode: 'sandbox' });
    expect(h.temp.db.prepare('SELECT state FROM payment_cases WHERE id = ?').get(scenario.caseId)).toEqual({ state: 'recovery_submitted' });
    expect(h.temp.db.prepare("SELECT source, item_status FROM provider_status_checks WHERE payment_item_id = ? AND source = 'webhook'").all(recovery_item_id)).toEqual([
      { source: 'webhook', item_status: 'UNCLAIMED' },
    ]);
    expect(h.temp.db.prepare("SELECT processing_state FROM paypal_webhook_events WHERE event_id = 'WH-EVT-LIE'").get()).toEqual({ processing_state: 'processed' });

    // When PayPal itself reports SUCCESS, the next event resolves the case from the fetched status.
    h.stub.setItemStatus(provider_item_id, 'SUCCESS');
    h.advance(60_000);
    const second = itemEvent('WH-EVT-TRUE', provider_item_id, provider_batch_id, 'SUCCESS');
    expect((await deliver(url, second, signedHeaders(second, { transmissionTime: h.now().toISOString() }))).status).toBe(200);
    await h.payouts.webhookProcessor.processPending();
    expect(h.temp.db.prepare('SELECT state FROM payment_cases WHERE id = ?').get(scenario.caseId)).toEqual({ state: 'resolved' });
  });

  it('writes a development capture with the original headers, raw body and certificate', async () => {
    h = await startSandboxHarness({ start: NOW, fetchCert: countingFetcher().fetchCert });
    captureDir = mkdtempSync(join(tmpdir(), 'rr-webhook-capture-'));
    const url = await listen(h.temp.db, h.payouts.verifyWebhook, { captureDir });
    const body = itemEvent('WH-EVT-CAP', 'ITEMCAP', 'BATCHCAP');
    const headers = signedHeaders(body, { transmissionId: 'tx-cap' });
    expect((await deliver(url, body, headers)).status).toBe(200);
    const [file] = readdirSync(captureDir);
    const capture = JSON.parse(readFileSync(join(captureDir, file!), 'utf8')) as { verification: string; headers: WebhookHeaders; bodyBase64: string; certPem: string };
    expect(capture.verification).toBe('verified');
    expect(capture.headers).toEqual(headers);
    expect(Buffer.from(capture.bodyBase64, 'base64').equals(body)).toBe(true);
    expect(capture.certPem).toBe(TEST_WEBHOOK_CERT_PEM);
  });
});

interface GenuineFixture {
  capturedAt: string;
  webhookId: string;
  headers: WebhookHeaders;
  bodyBase64: string;
  certPem: string;
}

describe.skipIf(!existsSync(GENUINE_FIXTURE))('genuine PayPal Sandbox webhook delivery', () => {
  const fixture = () => JSON.parse(readFileSync(GENUINE_FIXTURE, 'utf8')) as GenuineFixture;
  const at = () => new Date(Date.parse(fixture().capturedAt));

  it('verifies with its original headers, raw body and PayPal certificate', async () => {
    const f = fixture();
    expect(validateCertUrl(f.headers.certUrl).ok).toBe(true);
    const verify = createWebhookVerifier({ webhookId: f.webhookId, fetchCert: async () => f.certPem, clock: at });
    await expect(verify(Buffer.from(f.bodyBase64, 'base64'), f.headers)).resolves.toMatchObject({ ok: true });
  });

  it('fails when one byte of the genuine body changes, or the webhook ID differs', async () => {
    const f = fixture();
    const verify = createWebhookVerifier({ webhookId: f.webhookId, fetchCert: async () => f.certPem, clock: at });
    const body = Buffer.from(f.bodyBase64, 'base64');
    body[Math.floor(body.length / 2)] = body[Math.floor(body.length / 2)]! ^ 0x01;
    await expect(verify(body, f.headers)).resolves.toMatchObject({ ok: false, code: 'signature_invalid' });
    const otherId = createWebhookVerifier({ webhookId: `${f.webhookId}X`, fetchCert: async () => f.certPem, clock: at });
    await expect(otherId(Buffer.from(f.bodyBase64, 'base64'), f.headers)).resolves.toMatchObject({ ok: false, code: 'signature_invalid' });
  });
});
