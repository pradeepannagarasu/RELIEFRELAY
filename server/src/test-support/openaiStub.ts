import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A local stand-in for the OpenAI Responses endpoint. Each request is answered by the next scripted handler. */

export interface StubRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export type StubHandler = (res: ServerResponse, request: StubRequest) => void;

export interface OpenAiStub {
  baseUrl: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

export const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): StubHandler =>
  (res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

/** Never answers, so the client's timeout fires. */
export const hang: StubHandler = () => undefined;

/** Closes the connection without a response. */
export const drop: StubHandler = (res) => res.socket?.destroy();

export const completed = (output: unknown, extra: Record<string, unknown> = {}) =>
  json(200, {
    id: 'resp_stub_1',
    object: 'response',
    status: 'completed',
    model: 'gpt-6.1-sol-2026-10-01',
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: typeof output === 'string' ? output : JSON.stringify(output) }] },
    ],
    usage: { input_tokens: 2310, output_tokens: 1200 },
    ...extra,
  });

export async function startOpenAiStub(...handlers: StubHandler[]): Promise<OpenAiStub> {
  const requests: StubRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const request: StubRequest = { path: req.url ?? '', headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
      requests.push(request);
      const handler = handlers[Math.min(requests.length - 1, handlers.length - 1)];
      if (handler) handler(res, request);
      else json(500, { error: { message: 'no handler' } })(res, request);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
