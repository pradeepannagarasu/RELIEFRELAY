import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IMPORT_LIMITS } from '@shared/domain/imports';
import { DEMO_IDENTITY_COOKIE, DEMO_WRITE_HEADER } from '../middleware/auth';
import { JUDGE_GATEWAY_HEADER, PUBLIC_GATEWAY_HEADER, PUBLIC_READ_ONLY_MESSAGE } from '../middleware/publicDemo';
import { createRateLimiter, type RateDecision, type RateLimiter, type RateRule } from './rateLimit';

/**
 * Public demonstration gateway. The only process the public tunnel reaches:
 * - serves the built browser app from dist/web (never the Vite development server, which can serve source and data files);
 * - read_only mode: forwards GET and HEAD requests under /api, marked with the public gateway header so the API also
 *   enforces read-only access and acts as the viewer account; refuses every other method and the role endpoints;
 * - judge mode: forwards the app's reads and writes to the isolated Judge Demo API (local PayPal stub, own database),
 *   marked with the judge gateway header that every other API refuses; blocks administrative endpoints, passes only
 *   the signed demo identity cookie, limits body sizes and rate-limits each visitor.
 * The private local workflow (Vite on localhost:5173) does not pass through this gateway and is unchanged.
 */

export type GatewayMode = 'read_only' | 'judge';

export interface GatewayOptions {
  staticDir: string;
  apiOrigin: string;
  apiTimeoutMs?: number;
  mode?: GatewayMode;
  limiter?: RateLimiter;
}

const READ_METHODS = new Set(['GET', 'HEAD']);
export const JUDGE_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT']);
export const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'user-agent', 'if-none-match', 'if-modified-since'];
export const JUDGE_WRITE_HEADERS = ['content-type', 'content-length', DEMO_WRITE_HEADER];
const DROPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding']);

export const JUDGE_ADMIN_MESSAGE = 'Administrative operations (PayPal credentials, connection checks, allowlists, provider mode and system settings) are not available in the public Judge Demo.';
/** Generous for CSV uploads (the API enforces its own limit); small for everything else. */
export const MAX_UPLOAD_BYTES = IMPORT_LIMITS.maxBytes + 64 * 1024;
export const MAX_BODY_BYTES = 128 * 1024;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const JUDGE_RATE_RULES = {
  requests: { name: 'requests', limit: 300, windowMs: MINUTE },
  writes: { name: 'writes', limit: 80, windowMs: 10 * MINUTE },
  investigations: { name: 'investigations', limit: 3, windowMs: 15 * MINUTE },
  investigationsDaily: { name: 'investigations-day', limit: 8, windowMs: DAY },
  investigationsGlobal: { name: 'investigations-all', limit: 30, windowMs: 60 * MINUTE },
  imports: { name: 'imports', limit: 10, windowMs: 15 * MINUTE },
  importsDaily: { name: 'imports-day', limit: 25, windowMs: DAY },
  importsGlobal: { name: 'imports-all', limit: 60, windowMs: 60 * MINUTE },
  scenarios: { name: 'scenarios', limit: 12, windowMs: 15 * MINUTE },
  scenariosDaily: { name: 'scenarios-day', limit: 30, windowMs: DAY },
  approvalsDaily: { name: 'approvals-day', limit: 6, windowMs: DAY },
} satisfies Record<string, RateRule>;

const LIMITED_ACTIONS: [prefix: string, label: string][] = [
  ['investigations', 'AI investigations'],
  ['imports', 'CSV imports'],
  ['scenarios', 'new demo cases'],
  ['approvals', 'payout approvals'],
];

function waitText(seconds: number): string {
  if (seconds < 120) return `${seconds} seconds`;
  if (seconds < 2 * 3600) return `${Math.ceil(seconds / 60)} minutes`;
  return `about ${Math.ceil(seconds / 3600)} hours`;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function sendJsonError(res: ServerResponse, status: number, code: string, message: string, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify({ error: { code, message, requestId: null } });
  res.writeHead(status, { ...SECURITY_HEADERS, ...extraHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/** Only the signed demo identity cookie is passed on; every other cookie a visitor sends is dropped. */
export function identityCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    const value = rest.join('=');
    if (key === DEMO_IDENTITY_COOKIE && /^[A-Za-z0-9_.%-]{1,200}$/.test(value)) return `${DEMO_IDENTITY_COOKIE}=${value}`;
  }
  return null;
}

export function isIdentitySetCookie(value: string): boolean {
  return value.startsWith(`${DEMO_IDENTITY_COOKIE}=`);
}

/** The visitor's address as reported by Cloudflare. Only the local tunnel connects to this loopback-bound gateway. */
function clientKey(req: IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  return typeof cf === 'string' && cf.length <= 64 ? cf : (req.socket.remoteAddress ?? 'unknown');
}

/** AI investigations wait for the model (AI_TIMEOUT_MS, at most 120 s); everything else should answer quickly. */
const INVESTIGATION_TIMEOUT_MS = 130_000;

function proxyApi(req: IncomingMessage, res: ServerResponse, options: GatewayOptions, requested: URL, maxBody: number, onStatus?: (status: number) => void): void {
  const judge = options.mode === 'judge';
  const investigation = req.method === 'POST' && /^\/api\/cases\/[^/]+\/investigations\/?$/i.test(requested.pathname);
  const target = new URL(`${requested.pathname}${requested.search}`, options.apiOrigin);
  const headers: Record<string, string> = judge ? { [JUDGE_GATEWAY_HEADER]: '1' } : { [PUBLIC_GATEWAY_HEADER]: '1' };
  for (const name of judge ? [...FORWARDED_REQUEST_HEADERS, ...JUDGE_WRITE_HEADERS] : FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  if (judge) {
    const cookie = identityCookie(req.headers.cookie);
    if (cookie) headers.cookie = cookie;
  }
  const upstream = request(
    { protocol: target.protocol, hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: req.method, headers, timeout: investigation ? INVESTIGATION_TIMEOUT_MS : (options.apiTimeoutMs ?? 15_000) },
    (apiRes) => {
      const responseHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(apiRes.headers)) {
        if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name)) responseHeaders[name] = value;
      }
      const setCookie = judge ? (apiRes.headers['set-cookie'] ?? []).filter(isIdentitySetCookie) : [];
      if (setCookie.length > 0) responseHeaders['set-cookie'] = setCookie;
      res.writeHead(apiRes.statusCode ?? 502, responseHeaders);
      onStatus?.(apiRes.statusCode ?? 502);
      apiRes.pipe(res);
    },
  );
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', () => {
    if (!res.headersSent) sendJsonError(res, 502, 'service_unavailable', 'The ReliefRelay API is not reachable right now.');
    else res.destroy();
  });
  if (READ_METHODS.has(req.method ?? '')) return void upstream.end();

  let received = 0;
  req.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > maxBody) {
      upstream.destroy();
      if (!res.headersSent) sendJsonError(res, 413, 'payload_too_large', 'The request is too large.');
      req.destroy();
      return;
    }
    upstream.write(chunk);
  });
  req.on('end', () => upstream.end());
  req.on('error', () => upstream.destroy());
}

function serveStatic(req: IncomingMessage, res: ServerResponse, root: string): void {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://gateway').pathname);
  } catch {
    return sendJsonError(res, 400, 'bad_request', 'Malformed path.');
  }
  const candidate = normalize(join(root, pathname));
  if (candidate !== root && !candidate.startsWith(root + sep)) return sendJsonError(res, 404, 'not_found', 'Not found.');

  let file = candidate;
  const isFile = existsSync(file) && statSync(file).isFile();
  if (!isFile) {
    // Client-side routes (no file extension) get the app shell; missing assets are a plain 404.
    if (extname(pathname) !== '') return sendJsonError(res, 404, 'not_found', 'Not found.');
    file = join(root, 'index.html');
  }
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const immutable = file.startsWith(join(root, 'assets') + sep);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': String(statSync(file).size),
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}

/** Judge mode: administrative endpoints are never forwarded, whatever the method. */
export function isAdminPath(path: string, method: string): boolean {
  if (/^\/api\/integrations(\/|$)/.test(path) && !READ_METHODS.has(method)) return true;
  return /^\/api\/(admin|config|settings|credentials|allowlist|receivers|provider)(\/|$)/.test(path);
}

/** Approvals use up the shared daily payout limit, so only successful ones count towards a visitor's cap. */
export function isApproval(method: string, path: string): boolean {
  return method === 'POST' && /^\/api\/proposals\/[^/]+\/approve\/?$/.test(path);
}

export type JudgeLimitRefusal = { message: string; retryAfterSeconds: number };

/** Counts a judge request against every limit that applies to it; returns the refusal when one is exceeded. */
export function judgeLimitRefusal(limiter: RateLimiter, key: string, method: string, path: string): JudgeLimitRefusal | null {
  const checks: [string, RateRule][] = [[key, JUDGE_RATE_RULES.requests]];
  if (!READ_METHODS.has(method)) {
    checks.push([key, JUDGE_RATE_RULES.writes]);
    if (method === 'POST' && /^\/api\/cases\/[^/]+\/investigations\/?$/.test(path)) {
      checks.push([key, JUDGE_RATE_RULES.investigations], [key, JUDGE_RATE_RULES.investigationsDaily], ['all', JUDGE_RATE_RULES.investigationsGlobal]);
    }
    if (method === 'POST' && /^\/api\/imports\/?$/.test(path)) {
      checks.push([key, JUDGE_RATE_RULES.imports], [key, JUDGE_RATE_RULES.importsDaily], ['all', JUDGE_RATE_RULES.importsGlobal]);
    }
    if (method === 'POST' && /^\/api\/judge-demo\/scenarios\/?$/.test(path)) {
      checks.push([key, JUDGE_RATE_RULES.scenarios], [key, JUDGE_RATE_RULES.scenariosDaily]);
    }
  }
  const refuse = (k: string, rule: RateRule, decision: RateDecision): JudgeLimitRefusal => {
    const what = LIMITED_ACTIONS.find(([prefix]) => rule.name.startsWith(prefix))?.[1] ?? 'requests';
    const scope = k === 'all' ? 'from all visitors to the public demo' : rule.windowMs >= DAY ? 'from you today' : 'from you right now';
    return { message: `Too many ${what} ${scope}. Please wait ${waitText(decision.retryAfterSeconds)} and try again.`, retryAfterSeconds: decision.retryAfterSeconds };
  };
  for (const [k, rule] of checks) {
    const decision = limiter.hit(k, rule);
    if (!decision.allowed) return refuse(k, rule, decision);
  }
  if (isApproval(method, path)) {
    const decision = limiter.peek(key, JUDGE_RATE_RULES.approvalsDaily);
    if (!decision.allowed) return refuse(key, JUDGE_RATE_RULES.approvalsDaily, decision);
  }
  return null;
}

/** Applies the judge rate limits; returns false after answering 429. */
function withinJudgeLimits(req: IncomingMessage, res: ServerResponse, limiter: RateLimiter, path: string): boolean {
  const refusal = judgeLimitRefusal(limiter, clientKey(req), req.method ?? '', path);
  if (!refusal) return true;
  sendJsonError(res, 429, 'too_many_requests', refusal.message, { 'Retry-After': String(refusal.retryAfterSeconds) });
  return false;
}

export function createPublicGateway(options: GatewayOptions): Server {
  const root = resolve(options.staticDir);
  const judge = options.mode === 'judge';
  const limiter = options.limiter ?? createRateLimiter();
  if (!existsSync(join(root, 'index.html'))) throw new Error(`No built app at ${root}. Run npm run build first.`);
  return createServer((req, res) => {
    const method = req.method ?? '';
    if (!(judge ? JUDGE_METHODS : READ_METHODS).has(method)) {
      return judge
        ? sendJsonError(res, 405, 'forbidden', 'This method is not available in the public Judge Demo.', { Allow: 'GET, HEAD, POST, PUT' })
        : sendJsonError(res, 405, 'forbidden', PUBLIC_READ_ONLY_MESSAGE, { Allow: 'GET, HEAD' });
    }
    let requested: URL;
    try {
      requested = new URL(req.url ?? '/', 'http://gateway');
    } catch {
      return sendJsonError(res, 400, 'bad_request', 'Malformed path.');
    }
    const path = requested.pathname.toLowerCase();
    if (path === '/api' || path.startsWith('/api/')) {
      if (!judge) {
        if (/^\/api\/demo(\/|$)/.test(path)) return sendJsonError(res, 403, 'forbidden', PUBLIC_READ_ONLY_MESSAGE);
        return proxyApi(req, res, options, requested, 0);
      }
      if (path.includes('%') || path.includes('//')) return sendJsonError(res, 400, 'bad_request', 'Malformed path.');
      if (isAdminPath(path, method)) return sendJsonError(res, 403, 'forbidden', JUDGE_ADMIN_MESSAGE);
      if (!withinJudgeLimits(req, res, limiter, path)) return;
      const maxBody = method === 'POST' && /^\/api\/imports\/?$/.test(path) ? MAX_UPLOAD_BYTES : MAX_BODY_BYTES;
      const declared = Number(req.headers['content-length'] ?? 0);
      if (Number.isFinite(declared) && declared > maxBody) return sendJsonError(res, 413, 'payload_too_large', 'The request is too large.');
      const onStatus = isApproval(method, path)
        ? (status: number) => {
            if (status >= 200 && status < 300) limiter.hit(clientKey(req), JUDGE_RATE_RULES.approvalsDaily);
          }
        : undefined;
      return proxyApi(req, res, options, requested, maxBody, onStatus);
    }
    if (!READ_METHODS.has(method)) return sendJsonError(res, 405, 'forbidden', 'Only the API accepts changes.', { Allow: 'GET, HEAD' });
    serveStatic(req, res, root);
  });
}

/** Confirms the API behind a judge-mode gateway is the Judge Demo on the local PayPal stub before serving anyone. */
export async function assertJudgeApi(apiOrigin: string): Promise<void> {
  const response = await fetch(new URL('/api/session', apiOrigin), { headers: { [JUDGE_GATEWAY_HEADER]: '1', accept: 'application/json' } });
  const body = (await response.json().catch(() => null)) as { environment?: { judgeDemo?: boolean; paypalTarget?: string } } | null;
  if (!response.ok || body?.environment?.judgeDemo !== true || body.environment.paypalTarget !== 'local_stub') {
    throw new Error(`Refusing to start: ${apiOrigin} is not the Judge Demo API on the local PayPal stub.`);
  }
}

async function main(): Promise<void> {
  const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
  const port = Number(process.env.PUBLIC_GATEWAY_PORT ?? 4173);
  const mode: GatewayMode = process.env.PUBLIC_GATEWAY_MODE === 'judge' ? 'judge' : 'read_only';
  const apiOrigin = process.env.PUBLIC_GATEWAY_API_ORIGIN ?? `http://127.0.0.1:${mode === 'judge' ? (process.env.JUDGE_DEMO_PORT ?? 4100) : (process.env.API_PORT ?? 4000)}`;
  if (mode === 'judge') await assertJudgeApi(apiOrigin);
  const server = createPublicGateway({ staticDir: join(repoRoot, 'dist', 'web'), apiOrigin, mode });
  server.listen(port, '127.0.0.1', () => {
    console.log(
      mode === 'judge'
        ? `Public Judge Demo gateway on http://127.0.0.1:${port} (Judge Demo API ${apiOrigin}, local PayPal stub). Administrative endpoints are refused.`
        : `Public read-only demonstration gateway on http://127.0.0.1:${port} (API ${apiOrigin}). Writes are refused.`,
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
