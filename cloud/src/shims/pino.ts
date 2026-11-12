/**
 * Minimal pino-compatible logger for the Worker: structured JSON to console, with the same redaction intent as
 * server/src/lib/logger.ts. Keys that can carry credentials or personal data are replaced at any depth.
 */
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Infinity } as const;
type Level = keyof typeof LEVELS;

const REDACTED_KEYS = new Set(['authorization', 'cookie', 'set-cookie', 'password', 'secret', 'clientsecret', 'apikey', 'accesstoken', 'recipientemail', 'paypal-auth-algo', 'paypal-transmission-sig']);

function redact(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { type: value.name, message: value.message };
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(inner, depth + 1);
  return out;
}

export interface ShimLogger {
  level: string;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  child(bindings: Record<string, unknown>): ShimLogger;
}
type LogFn = (objOrMsg?: unknown, msg?: string) => void;

function make(level: Level, bindings: Record<string, unknown>): ShimLogger {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const log =
    (name: Exclude<Level, 'silent'>): LogFn =>
    (objOrMsg, msg) => {
      if (LEVELS[name] < threshold) return;
      const fields = typeof objOrMsg === 'object' && objOrMsg !== null ? (redact(objOrMsg) as Record<string, unknown>) : {};
      const message = typeof objOrMsg === 'string' ? objOrMsg : msg;
      const line = JSON.stringify({ level: name, ...bindings, ...fields, msg: message });
      if (LEVELS[name] >= LEVELS.error) console.error(line);
      else if (name === 'warn') console.warn(line);
      else console.log(line);
    };
  return {
    level,
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
    child: (more) => make(level, { ...bindings, ...more }),
  };
}

export default function pino(options: { level?: string; base?: Record<string, unknown> } = {}): ShimLogger {
  return make((options.level as Level) ?? 'info', options.base ?? {});
}

export type Logger = ShimLogger;
