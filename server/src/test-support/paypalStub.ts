import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local, stateful stand-in for the PayPal Payouts API, used by automated tests and the development-only
 * `npm run demo:local-stub` demonstration (never by the server itself). It honours PayPal-Request-Id
 * idempotency, refuses a reused sender_batch_id, and can be told to fail, drop or hang specific calls.
 */

export type StubRoute = 'token' | 'create' | 'get_batch' | 'get_item' | 'cancel';
export type Fault =
  | { kind: 'status'; status: number; body?: unknown }
  | { kind: 'drop' }
  | { kind: 'hang' }
  /** Process the request normally, then close the connection without answering. */
  | { kind: 'process_then_drop' }
  | { kind: 'malformed' };

export interface StubRequest {
  method: string;
  path: string;
  route: StubRoute | null;
  headers: IncomingHttpHeaders;
  body: string;
}

interface StubItem {
  payout_item_id: string;
  transaction_id: string | null;
  transaction_status: string;
  payout_batch_id: string;
  payout_item: { recipient_type: string; amount: { value: string; currency: string }; receiver: string; sender_item_id: string; note?: string };
}

interface StubBatch {
  payout_batch_id: string;
  batch_status: string;
  sender_batch_id: string;
  items: StubItem[];
}

export interface PayPalStub {
  baseUrl: string;
  requests: StubRequest[];
  batches: Map<string, StubBatch>;
  items: Map<string, StubItem>;
  /** Status given to new items. */
  initialItemStatus: string;
  initialBatchStatus: string;
  /** Faults applied, in order, to the next calls of a route. */
  faults: Record<StubRoute, Fault[]>;
  setItemStatus(itemId: string, status: string): void;
  /** Overrides fields in the next item response (for discrepancy tests). */
  itemOverrides: Partial<{ amount: { value: string; currency: string }; transaction_status: string; currency_conversion: unknown }>;
  count(route: StubRoute): number;
  /**
   * Re-creates a payout this stub answered before it was restarted, from the caller's own records of the stub's
   * responses. A PENDING item resumes its scripted outcome; any other status is kept as recorded.
   */
  restore(payout: StubRestore): void;
  close(): Promise<void>;
}

export interface StubRestore {
  batchId: string;
  senderBatchId: string;
  itemId: string;
  transactionId: string | null;
  status: string;
  payoutItem: StubItem['payout_item'];
}

const ROUTES: [StubRoute, string, RegExp][] = [
  ['token', 'POST', /^\/v1\/oauth2\/token$/],
  ['create', 'POST', /^\/v1\/payments\/payouts$/],
  ['get_batch', 'GET', /^\/v1\/payments\/payouts\/([A-Za-z0-9-]+)$/],
  ['get_item', 'GET', /^\/v1\/payments\/payouts-item\/([A-Za-z0-9-]+)$/],
  ['cancel', 'POST', /^\/v1\/payments\/payouts-item\/([A-Za-z0-9-]+)\/cancel$/],
];

/** What the stub answers to one request; `drop` and `hang` simulate a lost connection. */
export type StubReply = { kind: 'json'; status: number; body: unknown } | { kind: 'malformed' } | { kind: 'drop' } | { kind: 'hang' };

export interface StubIncoming {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const json = (status: number, body: unknown): StubReply => ({ kind: 'json', status, body });

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'PayPal-Debug-Id': 'stubdebug01' });
  res.end(JSON.stringify(body));
};

/** A scripted outcome: the item starts PENDING and reports `finalStatus` once `afterMs` has passed. */
export interface StubOutcome {
  finalStatus: string;
  afterMs: number;
}

export interface PayPalStubOptions {
  clientId?: string;
  clientSecret?: string;
  /** Scripted outcomes by receiver. Receivers without one keep the default behaviour (initialItemStatus). */
  outcomeFor?: (receiver: string) => StubOutcome | null;
  now?: () => number;
}

/** The stub's state and request handling without a server, for runtimes that answer its requests in-process. */
export function createPayPalStub(options: PayPalStubOptions = {}): { stub: PayPalStub; handle: (request: StubIncoming) => StubReply } {
  const clientId = options.clientId ?? 'stub-client-id';
  const clientSecret = options.clientSecret ?? 'stub-client-secret';
  const now = options.now ?? Date.now;
  const requests: StubRequest[] = [];
  const batches = new Map<string, StubBatch>();
  const items = new Map<string, StubItem>();
  const scripted = new Map<string, { settleAt: number; finalStatus: string }>();
  const byRequestId = new Map<string, { status: number; body: unknown }>();
  const tokens = new Set<string>();
  const faults: Record<StubRoute, Fault[]> = { token: [], create: [], get_batch: [], get_item: [], cancel: [] };

  const stub: PayPalStub = {
    baseUrl: '',
    requests,
    batches,
    items,
    initialItemStatus: 'UNCLAIMED',
    initialBatchStatus: 'SUCCESS',
    faults,
    itemOverrides: {},
    setItemStatus(itemId, status) {
      const item = items.get(itemId);
      if (!item) throw new Error(`No stub item ${itemId}`);
      item.transaction_status = status;
    },
    count: (route) => requests.filter((r) => r.route === route).length,
    restore(payout) {
      if (items.has(payout.itemId)) return;
      let batch = batches.get(payout.batchId);
      if (!batch) {
        batch = { payout_batch_id: payout.batchId, batch_status: stub.initialBatchStatus, sender_batch_id: payout.senderBatchId, items: [] };
        batches.set(payout.batchId, batch);
      }
      const item: StubItem = {
        payout_item_id: payout.itemId,
        transaction_id: payout.transactionId,
        transaction_status: payout.status,
        payout_batch_id: payout.batchId,
        payout_item: payout.payoutItem,
      };
      items.set(item.payout_item_id, item);
      batch.items.push(item);
      const outcome = payout.status === 'PENDING' ? (options.outcomeFor?.(payout.payoutItem.receiver) ?? null) : null;
      if (outcome) scripted.set(item.payout_item_id, { settleAt: now() + outcome.afterMs, finalStatus: outcome.finalStatus });
    },
    close: async () => undefined,
  };

  const settle = (item: StubItem) => {
    const script = scripted.get(item.payout_item_id);
    if (script && item.transaction_status === 'PENDING' && now() >= script.settleAt) {
      item.transaction_status = script.finalStatus;
      scripted.delete(item.payout_item_id);
    }
  };
  const batchStatus = (batch: StubBatch) => (batch.items.some((i) => scripted.has(i.payout_item_id)) ? 'PROCESSING' : batch.batch_status);

  const itemBody = (item: StubItem) => {
    settle(item);
    const overrides = stub.itemOverrides;
    stub.itemOverrides = {};
    return {
      ...item,
      ...(overrides.transaction_status ? { transaction_status: overrides.transaction_status } : {}),
      ...(overrides.currency_conversion ? { currency_conversion: overrides.currency_conversion } : {}),
      payout_item: { ...item.payout_item, ...(overrides.amount ? { amount: overrides.amount } : {}) },
      links: [],
    };
  };
  const batchBody = (batch: StubBatch) => {
    batch.items.forEach(settle);
    return batchBodyOf(batch);
  };
  const batchBodyOf = (batch: StubBatch) => ({
    batch_header: { payout_batch_id: batch.payout_batch_id, batch_status: batchStatus(batch), sender_batch_header: { sender_batch_id: batch.sender_batch_id } },
    items: batch.items.map((i) => ({ ...i, links: [] })),
    links: [],
  });

  const handleRoute = (route: StubRoute, match: RegExpExecArray, request: StubRequest): (() => StubReply) => {
    if (route === 'token') {
      const expected = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      if (request.headers.authorization !== expected) return () => json(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
      const token = `stub-token-${randomUUID()}`;
      tokens.add(token);
      return () => json(200, { access_token: token, token_type: 'Bearer', expires_in: 32400, scope: 'https://uri.paypal.com/payments/payouts', app_id: 'APP-STUB' });
    }
    const auth = request.headers.authorization?.replace(/^Bearer /, '');
    if (!auth || !tokens.has(auth)) return () => json(401, { name: 'AUTHENTICATION_FAILURE', message: 'Authentication failed', debug_id: 'stubdebug01' });

    if (route === 'create') {
      const requestId = String(request.headers['paypal-request-id'] ?? '');
      const previous = byRequestId.get(requestId);
      if (previous) return () => json(previous.status, previous.body);
      const body = JSON.parse(request.body) as { sender_batch_header: { sender_batch_id: string }; items: StubItem['payout_item'][] };
      const senderBatchId = body.sender_batch_header.sender_batch_id;
      const existing = [...batches.values()].find((b) => b.sender_batch_id === senderBatchId);
      if (existing) {
        const error = {
          name: 'USER_BUSINESS_ERROR',
          message: 'User business error.',
          debug_id: 'stubdebug01',
          details: [{ field: 'SENDER_BATCH_ID', issue: `Batch with given sender_batch_id already exists` }],
          links: [{ href: `${stub.baseUrl}/v1/payments/payouts/${existing.payout_batch_id}`, rel: 'self', method: 'GET' }],
        };
        return () => json(400, error);
      }
      const batchId = `STUBBATCH${batches.size + 1}${randomUUID().slice(0, 6).toUpperCase()}`.replace(/-/g, '');
      const batch: StubBatch = { payout_batch_id: batchId, batch_status: stub.initialBatchStatus, sender_batch_id: senderBatchId, items: [] };
      for (const [index, item] of body.items.entries()) {
        const outcome = options.outcomeFor?.(item.receiver) ?? null;
        const stubItem: StubItem = {
          payout_item_id: `STUBITEM${items.size + 1}${index}${randomUUID().slice(0, 4).toUpperCase()}`.replace(/-/g, ''),
          transaction_id: `STUBTXN${items.size + 1}`,
          transaction_status: outcome ? 'PENDING' : stub.initialItemStatus,
          payout_batch_id: batchId,
          payout_item: item,
        };
        items.set(stubItem.payout_item_id, stubItem);
        if (outcome) scripted.set(stubItem.payout_item_id, { settleAt: now() + outcome.afterMs, finalStatus: outcome.finalStatus });
        batch.items.push(stubItem);
      }
      batches.set(batchId, batch);
      const response = {
        status: 201,
        body: { batch_header: { payout_batch_id: batchId, batch_status: 'PENDING', sender_batch_header: body.sender_batch_header }, links: [] },
      };
      byRequestId.set(requestId, response);
      return () => json(response.status, response.body);
    }
    if (route === 'get_batch') {
      const batch = batches.get(match[1]!);
      return () => (batch ? json(200, batchBody(batch)) : json(404, { name: 'INVALID_RESOURCE_ID', message: 'Requested resource ID was not found.', debug_id: 'stubdebug01' }));
    }
    if (route === 'get_item') {
      const item = items.get(match[1]!);
      return () => (item ? json(200, itemBody(item)) : json(404, { name: 'INVALID_RESOURCE_ID', message: 'Requested resource ID was not found.', debug_id: 'stubdebug01' }));
    }
    const item = items.get(match[1]!);
    if (!item) return () => json(404, { name: 'INVALID_RESOURCE_ID', message: 'Requested resource ID was not found.', debug_id: 'stubdebug01' });
    if (item.transaction_status !== 'UNCLAIMED') {
      return () => json(400, { name: 'ITEM_CANCELLATION_FAILED', message: 'Payout item cannot be cancelled because it is not unclaimed.', debug_id: 'stubdebug01' });
    }
    item.transaction_status = 'RETURNED';
    return () => json(200, itemBody(item));
  };

  const handle = (incoming: StubIncoming): StubReply => {
    const path = incoming.path.split('?')[0]!;
    let route: StubRoute | null = null;
    let match: RegExpExecArray | null = null;
    for (const [name, method, pattern] of ROUTES) {
      const m = incoming.method === method ? pattern.exec(path) : null;
      if (m) {
        route = name;
        match = m;
        break;
      }
    }
    const request: StubRequest = { method: incoming.method, path, route, headers: incoming.headers, body: incoming.body };
    requests.push(request);
    if (!route || !match) return json(404, { name: 'NOT_FOUND' });
    const fault = faults[route].shift();
    if (fault?.kind === 'drop') return { kind: 'drop' };
    if (fault?.kind === 'hang') return { kind: 'hang' };
    if (fault?.kind === 'status') return json(fault.status, fault.body ?? { name: 'INTERNAL_SERVICE_ERROR', debug_id: 'stubdebug01' });
    if (fault?.kind === 'malformed') return { kind: 'malformed' };
    const respond = handleRoute(route, match, request);
    if (fault?.kind === 'process_then_drop') return { kind: 'drop' };
    return respond();
  };

  return { stub, handle };
}

export async function startPayPalStub(options: PayPalStubOptions = {}): Promise<PayPalStub> {
  const { stub, handle } = createPayPalStub(options);
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const reply = handle({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: raw });
      if (reply.kind === 'drop') res.socket?.destroy();
      else if (reply.kind === 'malformed') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"unexpected": true');
      } else if (reply.kind === 'json') send(res, reply.status, reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}
