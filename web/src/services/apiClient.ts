import type { ApiErrorBody } from '@shared/api/contracts';

export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly details: unknown = undefined,
  ) {
    super(message);
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorBody).error?.message === 'string'
  );
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...init, headers: { Accept: 'application/json', ...init.headers } });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network_error', 'The ReliefRelay API could not be reached. Check that the server is running.', null);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiError(response.status, body.error.code, body.error.message, body.error.requestId, body.error.details);
    }
    throw new ApiError(response.status, 'unexpected_response', `The server responded with status ${response.status}.`, response.headers.get('x-request-id'));
  }
  return body as T;
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { signal });
}

/** Marks a write as coming from the ReliefRelay app; the server requires it under a role-demonstration identity. */
const APP_WRITE_HEADER = { 'X-ReliefRelay-Demo': '1' };

export function apiSend<T>(method: 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: body === undefined ? APP_WRITE_HEADER : { ...APP_WRITE_HEADER, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Sends a file's raw bytes as text/csv. The server parses and validates it; nothing is parsed in the browser. */
export function apiUploadCsv<T>(path: string, file: File): Promise<T> {
  return request<T>(`${path}?fileName=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { ...APP_WRITE_HEADER, 'Content-Type': 'text/csv' },
    body: file,
  });
}
