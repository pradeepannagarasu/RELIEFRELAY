import { afterEach, describe, expect, it } from 'vitest';
import { completed, drop, hang, json, startOpenAiStub, type OpenAiStub, type StubHandler } from '../test-support/openaiStub';
import { createOpenAiProvider, interpretResponseBody } from './openaiProvider';
import type { AiRequest } from './provider';

const KEY = 'sk-test-provider-key-never-shown';
const REQUEST: AiRequest = { instructions: 'INSTRUCTIONS', evidence: '{"evidence":[]}', schemaName: 'case_investigation', schema: { type: 'object' } };

let stub: OpenAiStub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

async function run(handlers: StubHandler[], timeoutMs = 5_000) {
  stub = await startOpenAiStub(...handlers);
  const provider = createOpenAiProvider({ apiKey: KEY, model: 'gpt-6.1-sol', baseUrl: stub.baseUrl, timeoutMs, maxOutputTokens: 8000, reasoningEffort: 'medium', retryDelayMs: 10 });
  return provider.investigate(REQUEST);
}

describe('OpenAI Responses adapter', () => {
  it('sends a strict structured-output request with store disabled and no sampling parameters', async () => {
    const result = await run([completed({ ok: 1 })]);
    expect(result).toMatchObject({ ok: true, output: { ok: 1 }, model: 'gpt-6.1-sol-2026-10-01', responseId: 'resp_stub_1', usage: { inputTokens: 2310, outputTokens: 1200 } });
    const [request] = stub!.requests;
    expect(request!.path).toBe('/v1/responses');
    expect(request!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request!.body).toEqual({
      model: 'gpt-6.1-sol',
      instructions: 'INSTRUCTIONS',
      input: [{ role: 'user', content: REQUEST.evidence }],
      text: { format: { type: 'json_schema', name: 'case_investigation', schema: { type: 'object' }, strict: true } },
      reasoning: { effort: 'medium' },
      max_output_tokens: 8000,
      store: false,
    });
    for (const banned of ['temperature', 'top_p', 'top_logprobs', 'tools', 'previous_response_id']) expect(request!.body).not.toHaveProperty(banned);
  });

  it('reports a refusal without keeping its text', async () => {
    const refusal = json(200, {
      id: 'resp_r',
      status: 'completed',
      model: 'gpt-6.1-sol',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'SECRET-REFUSAL-TEXT' }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const result = await run([refusal]);
    expect(result).toMatchObject({ ok: false, failure: 'refused', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(JSON.stringify(result)).not.toContain('SECRET-REFUSAL-TEXT');
  });

  it('treats an incomplete response as a failure, even if partial text exists', async () => {
    const incomplete = completed('{"known":[', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
    const result = await run([incomplete]);
    expect(result).toMatchObject({ ok: false, failure: 'incomplete' });
    if (!result.ok) expect(result.detail).toMatch(/output token limit/);
  });

  it('rejects output that is not valid JSON or has no text', async () => {
    expect(await run([completed('{"known": [')])).toMatchObject({ ok: false, failure: 'malformed_response' });
    await stub!.close();
    expect(await run([json(200, { status: 'completed', output: [] })])).toMatchObject({ ok: false, failure: 'malformed_response' });
    await stub!.close();
    expect(await run([(res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('<html>')])).toMatchObject({ ok: false, failure: 'malformed_response' });
  });

  it('distinguishes an unsupported schema from other rejected requests', async () => {
    const schemaError = json(400, { error: { message: 'Invalid schema for response_format: SECRET-PROVIDER-TEXT', type: 'invalid_request_error', param: 'text.format.schema', code: 'invalid_json_schema' } });
    const result = await run([schemaError]);
    expect(result).toMatchObject({ ok: false, failure: 'unsupported_schema' });
    expect(JSON.stringify(result)).not.toContain('SECRET-PROVIDER-TEXT');
    await stub!.close();
    expect(await run([json(400, { error: { message: 'Unsupported parameter: SECRET', param: 'reasoning.effort' } })])).toMatchObject({
      ok: false,
      failure: 'provider_rejected_request',
    });
    await stub!.close();
    expect(await run([json(401, { error: { message: 'Incorrect API key provided: sk-test-...' } })])).toMatchObject({ ok: false, failure: 'authentication_failed' });
  });

  it('does not retry a 429 response and reports Retry-After', async () => {
    const result = await run([json(429, { error: { message: 'Rate limit' } }, { 'retry-after': '20' }), completed({ ok: 1 })]);
    expect(result).toMatchObject({ ok: false, failure: 'rate_limited', retryAfterSeconds: 20 });
    expect(stub!.requests).toHaveLength(1);
  });

  it('retries a 5xx response once', async () => {
    expect(await run([json(503, { error: { message: 'overloaded' } }), completed({ ok: 2 })])).toMatchObject({ ok: true, output: { ok: 2 } });
    expect(stub!.requests).toHaveLength(2);
    await stub!.close();
    expect(await run([json(500, {}), json(502, {}), completed({ ok: 3 })])).toMatchObject({ ok: false, failure: 'provider_unavailable' });
    expect(stub!.requests).toHaveLength(2);
  });

  it('retries a dropped connection once', async () => {
    expect(await run([drop, completed({ ok: 4 })])).toMatchObject({ ok: true, output: { ok: 4 } });
    expect(stub!.requests).toHaveLength(2);
  });

  it('gives up at the overall deadline without retrying', async () => {
    const started = Date.now();
    const result = await run([hang, completed({ ok: 5 })], 400);
    expect(result).toMatchObject({ ok: false, failure: 'timeout' });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(stub!.requests).toHaveLength(1);
  });

  it('never includes the API key in any result', async () => {
    for (const handler of [json(401, { error: { message: `bad key ${KEY}` } }), json(500, { error: { message: KEY } }), completed({ echoed: 'nothing' })]) {
      const result = await run([handler, handler]);
      expect(JSON.stringify(result)).not.toContain(KEY);
      await stub!.close();
      stub = undefined;
    }
  });

  it('ignores implausible model names and response IDs', () => {
    const result = interpretResponseBody({
      id: 'resp with spaces <script>',
      status: 'completed',
      model: 'x'.repeat(500),
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }],
    });
    expect(result).toMatchObject({ ok: true, model: null, responseId: null });
  });
});
