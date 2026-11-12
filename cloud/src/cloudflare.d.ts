/**
 * The few Cloudflare Workers types this Worker uses. Declared here instead of loading @cloudflare/workers-types,
 * whose global fetch/URL types conflict with @types/node used by the shared server code.
 */
interface SqlStorageCursor {
  toArray(): Record<string, unknown>[];
}
interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlStorageCursor;
}
interface DurableObjectStorage {
  sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}
interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  waitUntil(promise: Promise<unknown>): void;
}
interface DurableObjectId {}
type DurableObjectStub<T> = { fetch(request: Request): Promise<Response> } & {
  [K in keyof T as T[K] extends (...args: never[]) => Promise<unknown> ? K : never]: T[K];
};
interface DurableObjectNamespace<T> {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub<T>;
}
interface Fetcher {
  fetch(request: Request): Promise<Response>;
}
interface ScheduledController {
  cron: string;
  scheduledTime: number;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
interface ExportedHandler<E> {
  fetch?(request: Request, env: E, ctx: ExecutionContext): Promise<Response>;
  scheduled?(controller: ScheduledController, env: E, ctx: ExecutionContext): Promise<void>;
}

declare module 'cloudflare:workers' {
  export abstract class DurableObject<E = unknown> {
    protected ctx: DurableObjectState;
    protected env: E;
    constructor(ctx: DurableObjectState, env: E);
    fetch?(request: Request): Promise<Response>;
    alarm?(): Promise<void>;
  }
}

declare module 'cloudflare:node' {
  export function handleAsNodeRequest(port: number, request: Request): Promise<Response>;
}
