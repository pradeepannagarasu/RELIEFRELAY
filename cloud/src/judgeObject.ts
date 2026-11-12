import { DurableObject } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { createApp, createInvestigations } from '../../server/src/app';
import { verifyAuditChain } from '../../server/src/audit/auditLog';
import { isLoopbackUrl, loadConfig } from '../../server/src/config/env';
import type { Db } from '../../server/src/db/connection';
import { createIdentitySigner, JUDGE_ROLES } from '../../server/src/judgeDemo/identity';
import { restoreStubPayouts } from '../../server/src/judgeDemo/persistence';
import { judgeOutcomeFor, registerJudgeReceivers } from '../../server/src/judgeDemo/scenarios';
import { createLogger } from '../../server/src/lib/logger';
import { JUDGE_GATEWAY_HEADER } from '../../server/src/middleware/publicDemo';
import { createPayoutModule, type PayoutModule } from '../../server/src/payouts/module';
import { createPayPalClient } from '../../server/src/paypal/client';
import {
  FORWARDED_REQUEST_HEADERS,
  identityCookie,
  isAdminPath,
  isApproval,
  isIdentitySetCookie,
  JUDGE_ADMIN_MESSAGE,
  JUDGE_METHODS,
  JUDGE_RATE_RULES,
  JUDGE_WRITE_HEADERS,
  judgeLimitRefusal,
  MAX_BODY_BYTES,
  MAX_UPLOAD_BYTES,
  SECURITY_HEADERS,
} from '../../server/src/publicDemo/gateway';
import { DEMO_SESSION_USER_ID } from '../../server/src/seed/syntheticDataset';
import { createPayPalStub } from '../../server/src/test-support/paypalStub';
import { createDoDatabase } from './doSqlite';
import { createSqlRateLimiter, RATE_LIMIT_TABLE } from './sqlRateLimit';

export interface Env {
  JUDGE_DEMO: DurableObjectNamespace<JudgeDemo>;
  ASSETS: Fetcher;
  /** 64 hex characters; signs the demo identity cookie. Worker secret. */
  JUDGE_IDENTITY_SECRET: string;
  /** Worker secret. Without it AI investigation is off. */
  OPENAI_API_KEY?: string;
  /** Worker secret, only set while the one-time data import runs. */
  IMPORT_TOKEN?: string;
  OPENAI_MODEL?: string;
  OPENAI_REASONING_EFFORT?: string;
  AI_TIMEOUT_MS?: string;
  AI_MAX_OUTPUT_TOKENS?: string;
  JUDGE_AI_DAILY_LIMIT?: string;
  /** "false" only in the local preview; anything else redirects plain HTTP to HTTPS. */
  ENFORCE_HTTPS?: string;
}

/**
 * The PayPal "API" of the cloud Judge Demo: a loopback address that is never fetched over the network. Every request
 * to it is answered in-process by the scripted PayPal stub, and any other address is refused, so the cloud Judge Demo
 * cannot reach PayPal (Sandbox or Live) at all.
 */
const STUB_BASE = 'http://127.0.0.1:9';
const STUB_CLIENT_ID = 'judge-demo-stub-client-id';
const STUB_CLIENT_SECRET = 'judge-demo-stub-client-secret';
/** Routing key of the in-object HTTP server (in local previews it is also bound, so avoid the local demo's ports). */
const APP_PORT = 47911;
const INVESTIGATION_TIMEOUT_MS = 130_000;
const API_TIMEOUT_MS = 20_000;
const POLL_PENDING_MS = 10_000;
const ALARM_MS = 15_000;
const DROPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding']);

const META_TABLE = `CREATE TABLE IF NOT EXISTS cloud_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`;

function jsonError(status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message, requestId: null } }), {
    status,
    headers: { ...SECURITY_HEADERS, ...extra, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function headersObject(init: RequestInit['headers']): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  new Headers(init).forEach((value, key) => (out[key] = value));
  return out;
}

/**
 * The in-object HTTP server is registered per isolate and outlives a Durable Object instance that is recreated in the
 * same isolate, so it is created once and always dispatches to the most recently booted app.
 */
let currentApp: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
let sharedServer: ReturnType<typeof createServer> | null = null;
function isolateServer(): ReturnType<typeof createServer> {
  if (!sharedServer) {
    sharedServer = createServer((req, res) => {
      if (currentApp) return currentApp(req, res);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'service_unavailable', message: 'The ReliefRelay Judge Demo is not ready yet.', requestId: null } }));
    });
    sharedServer.listen(APP_PORT);
  }
  return sharedServer;
}

interface Running {
  db: Db;
  payouts: PayoutModule;
  server: ReturnType<typeof createServer>;
  port: number;
}

export class JudgeDemo extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly limiter: ReturnType<typeof createSqlRateLimiter>;
  private running: Running | null = null;
  private ticking = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(META_TABLE).toArray();
    this.sql.exec(RATE_LIMIT_TABLE).toArray();
    this.limiter = createSqlRateLimiter(this.sql);
    ctx.blockConcurrencyWhile(async () => {
      if (this.meta('state') === 'imported') this.boot();
    });
  }

  private meta(key: string): string | null {
    const row = this.sql.exec('SELECT value FROM cloud_meta WHERE key = ?', key).toArray()[0];
    return row ? String(row.value) : null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec('INSERT INTO cloud_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value).toArray();
  }

  private boot(): Running {
    if (this.running) return this.running;
    const secret = this.env.JUDGE_IDENTITY_SECRET ?? '';
    if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error('JUDGE_IDENTITY_SECRET must be 64 hex characters.');

    const config = loadConfig({
      NODE_ENV: 'development',
      PORT: '4100',
      LOG_LEVEL: 'info',
      PAYMENT_PROVIDER_MODE: 'sandbox',
      PAYPAL_API_BASE_URL: STUB_BASE,
      PAYPAL_CLIENT_ID: STUB_CLIENT_ID,
      PAYPAL_CLIENT_SECRET: STUB_CLIENT_SECRET,
      PAYPAL_PAYOUTS_ENABLED: 'true',
      PAYPAL_WEBHOOK_ID: '',
      PAYPAL_POLL_INTERVAL_MS: '60000',
      DEMO_ROLE_SWITCHER: 'false',
      OPENAI_API_KEY: this.env.OPENAI_API_KEY ?? '',
      OPENAI_MODEL: this.env.OPENAI_MODEL ?? '',
      OPENAI_REASONING_EFFORT: this.env.OPENAI_REASONING_EFFORT ?? 'medium',
      AI_TIMEOUT_MS: this.env.AI_TIMEOUT_MS ?? '45000',
      AI_MAX_OUTPUT_TOKENS: this.env.AI_MAX_OUTPUT_TOKENS ?? '8000',
      AI_DAILY_INVESTIGATION_LIMIT: this.env.JUDGE_AI_DAILY_LIMIT ?? '40',
      DATABASE_PATH: 'durable-object/judge-demo',
    });
    if (config.paypal.target !== 'local_stub' || config.paypal.apiBaseUrl !== STUB_BASE || !isLoopbackUrl(config.paypal.apiBaseUrl)) {
      throw new Error('Refusing to start: the cloud Judge Demo PayPal API is not the in-process stub.');
    }
    if (config.paypal.clientId !== STUB_CLIENT_ID || config.paypal.clientSecret !== STUB_CLIENT_SECRET) {
      throw new Error('Refusing to start: the cloud Judge Demo must use stub credentials only.');
    }

    const logger = createLogger(config);
    const db = createDoDatabase(this.sql, (fn) => this.ctx.storage.transactionSync(fn));
    const clock = () => new Date();

    const { stub, handle } = createPayPalStub({ clientId: STUB_CLIENT_ID, clientSecret: STUB_CLIENT_SECRET, outcomeFor: judgeOutcomeFor });
    stub.baseUrl = STUB_BASE;
    const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== STUB_BASE) throw new TypeError('The cloud Judge Demo only talks to its in-process PayPal stub.');
      const reply = handle({ method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname, headers: headersObject(init?.headers), body: typeof init?.body === 'string' ? init.body : '' });
      if (stub.requests.length > 200) stub.requests.splice(0, stub.requests.length - 200);
      if (reply.kind === 'drop' || reply.kind === 'hang') throw new TypeError('network error');
      if (reply.kind === 'malformed') return new Response('{"unexpected": true', { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json', 'PayPal-Debug-Id': 'stubdebug01' } });
    }) as typeof fetch;

    const now = clock();
    const { organisation_id: org } = db.prepare('SELECT organisation_id FROM users WHERE id = ?').get(DEMO_SESSION_USER_ID) as { organisation_id: string };
    registerJudgeReceivers(db, org, now);
    const restored = restoreStubPayouts(db, stub);

    const client = createPayPalClient({ baseUrl: STUB_BASE, clientId: STUB_CLIENT_ID, clientSecret: STUB_CLIENT_SECRET, clock, fetchImpl: stubFetch });
    const payouts = createPayoutModule({ db, config, clock, logger, client, pollPendingMs: POLL_PENDING_MS, pollUnclaimedMs: 60_000 });
    const interruptedSends = payouts.submissions.recoverInterrupted();
    const interruptedInvestigations = createInvestigations({ config, logger, db, demoUserId: DEMO_SESSION_USER_ID, clock }).recoverInterrupted();

    const signer = createIdentitySigner(Buffer.from(secret, 'hex'));
    const app = createApp({ config, logger, db, demoUserId: DEMO_SESSION_USER_ID, clock, payouts, judgeDemo: { signer, roles: JUDGE_ROLES } });
    currentApp = app;
    const server = isolateServer();
    const port = APP_PORT;
    logger.info({ restored, interruptedSends, interruptedInvestigations }, 'Cloud Judge Demo started (in-process PayPal stub; nothing is sent to PayPal)');
    this.running = { db, payouts, server, port };
    return this.running;
  }

  /** Scheduled work: the same worker tick as the local Judge Demo (expiry, due sends, status polling). Read-only towards PayPal except approved sends. */
  async tick(): Promise<{ ran: boolean }> {
    if (!this.running || this.ticking) return { ran: false };
    this.ticking = true;
    try {
      await this.running.payouts.tick();
      this.limiter.sweep();
    } finally {
      this.ticking = false;
    }
    await this.scheduleFollowUp();
    return { ran: true };
  }

  /** While a simulated payout is still open, check again in ALARM_MS instead of waiting for the next minute. */
  private async scheduleFollowUp(): Promise<void> {
    if (!this.running) return;
    const open = this.sql
      .exec(
        `SELECT count(*) AS n FROM payout_submissions s
         JOIN payout_submission_items si ON si.submission_id = s.id
         JOIN payment_batches b ON b.id = s.recovery_batch_id
         LEFT JOIN provider_transactions p ON p.payment_item_id = si.recovery_item_id
         WHERE s.state IN ('prepared', 'sending', 'outcome_unknown', 'not_processed')
            OR (s.state = 'accepted' AND (p.status IS NULL OR p.status = 'PENDING' OR b.provider_status IS NULL OR b.provider_status IN ('PENDING', 'PROCESSING')))`,
      )
      .toArray()[0];
    if (Number(open?.n ?? 0) > 0 && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }

  override async alarm(): Promise<void> {
    await this.tick();
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__cloud/import/')) return this.handleImport(request, url.pathname.slice('/__cloud/import/'.length));
    if (!this.running) return jsonError(503, 'service_unavailable', 'The ReliefRelay Judge Demo is not ready yet.');
    const response = await this.gateway(request, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') this.ctx.waitUntil(this.scheduleFollowUp());
    return response;
  }

  /** The judge-mode rules of server/src/publicDemo/gateway.ts, applied in front of the Express app. */
  private async gateway(request: Request, url: URL): Promise<Response> {
    const method = request.method.toUpperCase();
    if (!JUDGE_METHODS.has(method)) return jsonError(405, 'forbidden', 'This method is not available in the public Judge Demo.', { Allow: 'GET, HEAD, POST, PUT' });
    const path = url.pathname.toLowerCase();
    if (path.includes('%') || path.includes('//')) return jsonError(400, 'bad_request', 'Malformed path.');
    if (isAdminPath(path, method)) return jsonError(403, 'forbidden', JUDGE_ADMIN_MESSAGE);

    const clientKey = request.headers.get('cf-connecting-ip')?.slice(0, 64) || 'unknown';
    const refusal = judgeLimitRefusal(this.limiter, clientKey, method, path);
    if (refusal) return jsonError(429, 'too_many_requests', refusal.message, { 'Retry-After': String(refusal.retryAfterSeconds) });

    const maxBody = method === 'POST' && /^\/api\/imports\/?$/.test(path) ? MAX_UPLOAD_BYTES : MAX_BODY_BYTES;
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > maxBody) return jsonError(413, 'payload_too_large', 'The request is too large.');
    let body: ArrayBuffer | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      body = await request.arrayBuffer();
      if (body.byteLength > maxBody) return jsonError(413, 'payload_too_large', 'The request is too large.');
    }

    const headers = new Headers({ [JUDGE_GATEWAY_HEADER]: '1' });
    for (const name of [...FORWARDED_REQUEST_HEADERS, ...JUDGE_WRITE_HEADERS]) {
      const value = request.headers.get(name);
      if (value !== null && name !== 'content-length') headers.set(name, value);
    }
    if (body !== undefined) headers.set('content-length', String(body.byteLength));
    const cookie = identityCookie(request.headers.get('cookie') ?? undefined);
    if (cookie) headers.set('cookie', cookie);

    const investigation = method === 'POST' && /^\/api\/cases\/[^/]+\/investigations\/?$/i.test(url.pathname);
    const inner = new Request(`http://judge.internal${url.pathname}${url.search}`, { method, headers, body });
    let apiResponse: Response;
    try {
      apiResponse = await Promise.race([
        handleAsNodeRequest(this.running!.port, inner),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), investigation ? INVESTIGATION_TIMEOUT_MS : API_TIMEOUT_MS)),
      ]);
    } catch {
      return jsonError(502, 'service_unavailable', 'The ReliefRelay API is not reachable right now.');
    }

    const outHeaders = new Headers();
    apiResponse.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) outHeaders.set(name, value);
    });
    for (const value of apiResponse.headers.getSetCookie()) {
      if (isIdentitySetCookie(value)) outHeaders.append('set-cookie', /;\s*secure/i.test(value) ? value : `${value}; Secure`);
    }
    if (isApproval(method, path) && apiResponse.status >= 200 && apiResponse.status < 300) this.limiter.hit(clientKey, JUDGE_RATE_RULES.approvalsDaily);
    return new Response(apiResponse.body, { status: apiResponse.status, headers: outHeaders });
  }

  // ---- One-time import of the local Judge Demo database (protected by the IMPORT_TOKEN check in worker.ts) ----

  private async handleImport(request: Request, step: string): Promise<Response> {
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    if (request.method !== 'POST') return reply(405, { error: 'POST only' });
    if (this.meta('state') === 'imported') return reply(409, { error: 'The Judge Demo data has already been imported; the import is closed.' });
    const input = (await request.json()) as Record<string, unknown>;
    try {
      if (step === 'begin') return reply(200, this.importBegin(input.schema as string[]));
      if (step === 'rows') return reply(200, this.importRows(String(input.table), input.columns as string[], input.rows as unknown[][]));
      if (step === 'finish') return reply(200, this.importFinish(input as { triggers: string[]; counts: Record<string, number>; auditHead: { seq: number; hash: string } | null }));
      return reply(404, { error: 'Unknown import step' });
    } catch (error) {
      return reply(400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private appTables(): string[] {
    return this.sql
      .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('cloud_meta', 'cloud_rate_limits')`)
      .toArray()
      .map((r) => String(r.name));
  }

  private importBegin(schema: string[]): { tables: number } {
    if (!Array.isArray(schema) || schema.some((s) => typeof s !== 'string' || !/^CREATE (TABLE|INDEX|UNIQUE INDEX) /i.test(s.trim()))) {
      throw new Error('The schema must only contain CREATE TABLE and CREATE INDEX statements.');
    }
    this.ctx.storage.transactionSync(() => {
      for (const name of this.appTables()) this.sql.exec(`DROP TABLE "${name.replace(/"/g, '""')}"`).toArray();
      for (const statement of schema) this.sql.exec(statement).toArray();
      this.setMeta('state', 'importing');
    });
    return { tables: this.appTables().length };
  }

  private importRows(table: string, columns: string[], rows: unknown[][]): { inserted: number } {
    if (this.meta('state') !== 'importing') throw new Error('Start the import first.');
    if (!this.appTables().includes(table)) throw new Error(`Unknown table ${table}`);
    const known = new Set(this.sql.exec(`SELECT name FROM pragma_table_info(?)`, table).toArray().map((r) => String(r.name)));
    if (columns.length === 0 || columns.some((c) => !known.has(c))) throw new Error(`Unknown columns for ${table}`);
    const statement = `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    this.ctx.storage.transactionSync(() => {
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== columns.length) throw new Error(`Malformed row for ${table}`);
        this.sql.exec(statement, ...row).toArray();
      }
    });
    return { inserted: rows.length };
  }

  private importFinish(input: { triggers: string[]; counts: Record<string, number>; auditHead: { seq: number; hash: string } | null }) {
    if (this.meta('state') !== 'importing') throw new Error('Start the import first.');
    if (!Array.isArray(input.triggers) || input.triggers.some((s) => typeof s !== 'string' || !/^CREATE TRIGGER /i.test(s.trim()))) {
      throw new Error('Only CREATE TRIGGER statements are accepted.');
    }
    const counts: Record<string, { expected: number; actual: number }> = {};
    for (const [table, expected] of Object.entries(input.counts)) {
      if (!this.appTables().includes(table)) throw new Error(`Unknown table ${table}`);
      const actual = Number(this.sql.exec(`SELECT count(*) AS n FROM "${table}"`).toArray()[0]!.n);
      counts[table] = { expected, actual };
    }
    const mismatched = Object.entries(counts).filter(([, c]) => c.expected !== c.actual);
    let foreignKeyProblems: number | null = null;
    try {
      foreignKeyProblems = this.sql.exec('PRAGMA foreign_key_check').toArray().length;
    } catch {
      foreignKeyProblems = null;
    }
    const db = createDoDatabase(this.sql, (fn) => this.ctx.storage.transactionSync(fn));
    const audit = verifyAuditChain(db, input.auditHead ?? undefined);
    const ok = mismatched.length === 0 && foreignKeyProblems === 0 && audit.ok;
    if (ok) {
      this.ctx.storage.transactionSync(() => {
        for (const statement of input.triggers) this.sql.exec(statement).toArray();
        this.setMeta('state', 'imported');
        this.setMeta('imported_at', new Date().toISOString());
      });
      this.boot();
    }
    return { ok, counts, mismatched: mismatched.map(([t]) => t), foreignKeyProblems, audit: { ok: audit.ok, eventCount: audit.eventCount, head: audit.head, problems: audit.problems.slice(0, 5) }, triggers: input.triggers.length };
  }

  /** Read-only status for verification scripts (counts, audit chain); reached through worker.ts with the import token only. */
  async status(): Promise<{ state: string | null; auditOk: boolean | null; events: number | null }> {
    if (!this.running) return { state: this.meta('state'), auditOk: null, events: null };
    const audit = verifyAuditChain(this.running.db);
    return { state: this.meta('state'), auditOk: audit.ok, events: audit.eventCount };
  }
}
