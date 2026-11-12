import type { AiProvider, AiRequest, AiResponse, AiUsage } from './provider';

/**
 * OpenAI Responses API adapter using Node's built-in fetch.
 *
 * - store: false, strict json_schema output, no tools, no sampling parameters (the reasoning models reject them).
 * - One overall deadline per investigation. Network errors and 5xx responses are retried once if time remains;
 *   429 responses are never retried automatically.
 * - Nothing from the request or from provider error messages is logged or returned. Failures are reduced to a
 *   fixed code and a fixed description.
 */

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxOutputTokens: number;
  reasoningEffort: 'low' | 'medium' | 'high';
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
}

const NO_USAGE: AiUsage = { inputTokens: null, outputTokens: null };
const MODEL_NAME = /^[A-Za-z0-9._:-]{1,100}$/;
const RESPONSE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MIN_TIME_FOR_RETRY_MS = 2_000;

type Failure = Extract<AiResponse, { ok: false }>;

const fail = (failure: Failure['failure'], detail: string, extra: Partial<Failure> = {}): Failure => ({
  ok: false,
  failure,
  detail,
  model: null,
  responseId: null,
  usage: NO_USAGE,
  ...extra,
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);

function usageOf(body: Record<string, unknown>): AiUsage {
  const usage = isRecord(body.usage) ? body.usage : {};
  return { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens) };
}

function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds), 3600);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.min(Math.ceil((date - Date.now()) / 1000), 3600));
}

/** Classifies a 400 response without keeping any of its text. */
async function isSchemaError(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.json();
    const error = isRecord(body) && isRecord(body.error) ? body.error : {};
    const param = typeof error.param === 'string' ? error.param : '';
    const code = typeof error.code === 'string' ? error.code : '';
    const message = typeof error.message === 'string' ? error.message : '';
    return param.startsWith('text.format') || /schema/i.test(code) || /json[_ ]schema|response_format|text\.format/i.test(message);
  } catch {
    return false;
  }
}

export function interpretResponseBody(body: unknown): AiResponse {
  if (!isRecord(body)) return fail('malformed_response', 'The provider response was not a JSON object.');
  const model = typeof body.model === 'string' && MODEL_NAME.test(body.model) ? body.model : null;
  const responseId = typeof body.id === 'string' && RESPONSE_ID.test(body.id) ? body.id : null;
  const usage = usageOf(body);
  const meta = { model, responseId, usage };

  if (body.status === 'incomplete') {
    const reason = isRecord(body.incomplete_details) ? body.incomplete_details.reason : null;
    const known = reason === 'max_output_tokens' ? 'the output token limit was reached' : reason === 'content_filter' ? 'a content filter stopped it' : 'it stopped early';
    return fail('incomplete', `The model did not finish its response: ${known}.`, meta);
  }
  if (body.status !== 'completed') return fail('provider_unavailable', 'The provider did not complete the response.', meta);

  const output = Array.isArray(body.output) ? body.output : [];
  const message = output.find((item): item is Record<string, unknown> => isRecord(item) && item.type === 'message');
  const parts = message && Array.isArray(message.content) ? message.content.filter(isRecord) : [];
  if (parts.some((part) => part.type === 'refusal')) return fail('refused', 'The model declined to analyse this case.', meta);
  const textPart = parts.find((part) => part.type === 'output_text');
  if (!textPart || typeof textPart.text !== 'string') return fail('malformed_response', 'The provider response contained no output text.', meta);
  try {
    return { ok: true, output: JSON.parse(textPart.text) as unknown, ...meta };
  } catch {
    return fail('malformed_response', 'The model output was not valid JSON.', meta);
  }
}

export function createOpenAiProvider(options: OpenAiProviderOptions): AiProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/responses`;
  const retryDelayMs = options.retryDelayMs ?? 500;

  const send = async (request: AiRequest, remainingMs: number): Promise<AiResponse & { retryable?: boolean }> => {
    const body = JSON.stringify({
      model: options.model,
      instructions: request.instructions,
      input: [{ role: 'user', content: request.evidence }],
      text: { format: { type: 'json_schema', name: request.schemaName, schema: request.schema, strict: true } },
      reasoning: { effort: options.reasoningEffort },
      max_output_tokens: options.maxOutputTokens,
      store: false,
    });
    const signal = AbortSignal.timeout(remainingMs);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        signal,
      });
    } catch {
      if (signal.aborted) return fail('timeout', 'The AI provider did not respond within the time limit.');
      return { ...fail('provider_unavailable', 'The AI provider could not be reached.'), retryable: true };
    }

    if (response.status === 429) {
      return fail('rate_limited', 'The AI provider rate limit was reached.', { retryAfterSeconds: retryAfter(response.headers.get('retry-after')) });
    }
    if (response.status >= 500) return { ...fail('provider_unavailable', `The AI provider returned a server error (HTTP ${response.status}).`), retryable: true };
    if (response.status === 401 || response.status === 403) return fail('authentication_failed', 'The AI provider did not accept the configured API key.');
    if (response.status === 400) {
      return (await isSchemaError(response))
        ? fail('unsupported_schema', 'The configured model rejected the structured output schema.')
        : fail('provider_rejected_request', 'The AI provider rejected the request (HTTP 400).');
    }
    if (!response.ok) return fail('provider_rejected_request', `The AI provider rejected the request (HTTP ${response.status}).`);

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      if (signal.aborted) return fail('timeout', 'The AI provider did not respond within the time limit.');
      return fail('malformed_response', 'The provider response was not valid JSON.');
    }
    return interpretResponseBody(parsed);
  };

  return {
    name: 'openai',
    model: options.model,
    async investigate(request) {
      const deadline = Date.now() + options.timeoutMs;
      const first = await send(request, options.timeoutMs);
      if (first.ok || !first.retryable) return strip(first);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      const remaining = deadline - Date.now();
      if (remaining < MIN_TIME_FOR_RETRY_MS) return strip(first);
      return strip(await send(request, remaining));
    },
  };
}

function strip(response: AiResponse & { retryable?: boolean }): AiResponse {
  const { retryable: _retryable, ...rest } = response;
  return rest as AiResponse;
}
