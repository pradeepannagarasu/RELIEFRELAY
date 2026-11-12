import { z } from 'zod';

/**
 * Minimal PayPal REST client for the Payouts Sandbox: OAuth token, create a payout batch, read a batch or an item,
 * and cancel an unclaimed item. It never logs request bodies, tokens or credentials, and it only talks to the base
 * URL it is given (configuration only allows the PayPal Sandbox or a local stub).
 */

export interface PayPalClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  clock?: () => Date;
  /** Replaces the global fetch, e.g. to answer an in-process stub. */
  fetchImpl?: typeof fetch;
}

export type PayPalResult<T> =
  | { ok: true; status: number; body: T; debugId: string | null }
  | {
      ok: false;
      /** network: no HTTP response (timeout, refused, reset). http: PayPal answered with an error status. */
      kind: 'network' | 'http';
      status: number | null;
      name: string | null;
      message: string | null;
      debugId: string | null;
      /** HATEOAS link targets from the error body, e.g. the existing batch for a duplicate sender_batch_id. */
      links: string[];
      body: unknown;
    };

export interface PayPalClient {
  createPayout(body: string, paypalRequestId: string): Promise<PayPalResult<unknown>>;
  getBatch(payoutBatchId: string): Promise<PayPalResult<unknown>>;
  getItem(payoutItemId: string): Promise<PayPalResult<unknown>>;
  cancelItem(payoutItemId: string): Promise<PayPalResult<unknown>>;
  /** Obtains a token to prove the credentials work. Returns the granted scopes, never the token. */
  checkCredentials(): Promise<{ ok: true; scopes: string[]; appId: string | null } | { ok: false; status: number | null; name: string | null }>;
}

/** PayPal batch and item IDs are short alphanumeric strings; anything else is refused before it reaches a URL. */
export const PAYPAL_ID = /^[A-Za-z0-9-]{1,64}$/;

const TokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().positive(), scope: z.string().optional(), app_id: z.string().optional() });

const ErrorBody = z
  .object({
    name: z.string().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
    debug_id: z.string().optional(),
    links: z.array(z.object({ href: z.string() }).loose()).optional(),
  })
  .loose();

export function createPayPalClient({ baseUrl, clientId, clientSecret, timeoutMs = 15_000, clock = () => new Date(), fetchImpl = fetch }: PayPalClientOptions): PayPalClient {
  let token: { value: string; expiresAt: number; scopes: string[]; appId: string | null } | null = null;

  const failure = (status: number | null, body: unknown, kind: 'network' | 'http' = 'http'): PayPalResult<never> => {
    const parsed = ErrorBody.safeParse(body);
    const value = parsed.success ? parsed.data : {};
    return {
      ok: false,
      kind,
      status,
      name: (value.name ?? value.error ?? null)?.slice(0, 100) ?? null,
      message: value.message?.slice(0, 300) ?? null,
      debugId: value.debug_id?.slice(0, 64) ?? null,
      links: (value.links ?? []).map((l) => l.href).slice(0, 10),
      body,
    };
  };

  const readJson = async (response: Response): Promise<unknown> => {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  };

  const fetchToken = async (): Promise<{ ok: true } | { ok: false; status: number | null; name: string | null }> => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      return { ok: false, status: null, name: 'NETWORK_ERROR' };
    }
    const body = await readJson(response);
    if (!response.ok) {
      const parsed = ErrorBody.safeParse(body);
      return { ok: false, status: response.status, name: parsed.success ? (parsed.data.error ?? parsed.data.name ?? null) : null };
    }
    const parsed = TokenResponse.safeParse(body);
    if (!parsed.success) return { ok: false, status: response.status, name: 'MALFORMED_TOKEN_RESPONSE' };
    token = {
      value: parsed.data.access_token,
      expiresAt: clock().getTime() + Math.max(0, parsed.data.expires_in - 60) * 1000,
      scopes: (parsed.data.scope ?? '').split(/\s+/).filter(Boolean),
      appId: parsed.data.app_id ?? null,
    };
    return { ok: true };
  };

  const ensureToken = async () => {
    if (token && token.expiresAt > clock().getTime()) return { ok: true } as const;
    token = null;
    return fetchToken();
  };

  const call = async (method: 'GET' | 'POST', path: string, init: { body?: string; headers?: Record<string, string> } = {}, retryAuth = true): Promise<PayPalResult<unknown>> => {
    const auth = await ensureToken();
    if (!auth.ok) {
      return { ok: false, kind: auth.status === null ? 'network' : 'http', status: auth.status === null ? null : 401, name: auth.name ?? 'AUTHENTICATION_FAILURE', message: 'Could not obtain a PayPal access token.', debugId: null, links: [], body: null };
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token!.value}`,
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        body: init.body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      return failure(null, null, 'network');
    }
    const debugId = response.headers.get('paypal-debug-id');
    if (response.status === 401 && retryAuth) {
      token = null;
      return call(method, path, init, false);
    }
    let body: unknown;
    try {
      body = await readJson(response);
    } catch {
      return failure(null, null, 'network');
    }
    if (!response.ok) {
      const result = failure(response.status, body);
      return result.ok ? result : { ...result, debugId: result.debugId ?? debugId?.slice(0, 64) ?? null };
    }
    return { ok: true, status: response.status, body, debugId: debugId?.slice(0, 64) ?? null };
  };

  const assertId = (id: string) => {
    if (!PAYPAL_ID.test(id)) throw new Error('Refusing to use a malformed PayPal identifier.');
    return encodeURIComponent(id);
  };

  return {
    createPayout: (body, paypalRequestId) => call('POST', '/v1/payments/payouts', { body, headers: { 'PayPal-Request-Id': paypalRequestId } }),
    getBatch: (id) => call('GET', `/v1/payments/payouts/${assertId(id)}`),
    getItem: (id) => call('GET', `/v1/payments/payouts-item/${assertId(id)}`),
    cancelItem: (id) => call('POST', `/v1/payments/payouts-item/${assertId(id)}/cancel`, { headers: { 'Content-Type': 'application/json' } }),
    async checkCredentials() {
      token = null;
      const result = await fetchToken();
      if (!result.ok) return result;
      return { ok: true, scopes: token!.scopes, appId: token!.appId };
    },
  };
}
