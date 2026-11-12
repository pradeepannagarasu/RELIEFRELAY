import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULT_OPENAI_MODEL } from '@shared/domain/investigation';
import type { PayPalTarget } from '@shared/domain/payouts';

export const PAYPAL_SANDBOX_API = 'https://api-m.sandbox.paypal.com';
/** The only PayPal hosts ReliefRelay will call. Live hosts are refused in every environment. */
const PAYPAL_SANDBOX_HOSTS = new Set(['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com']);

const optionalSecret = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PAYMENT_PROVIDER_MODE: z.enum(['simulation', 'sandbox']).default('simulation'),
  PAYPAL_CLIENT_ID: optionalSecret,
  PAYPAL_CLIENT_SECRET: optionalSecret,
  PAYPAL_WEBHOOK_ID: optionalSecret,
  PAYPAL_API_BASE_URL: z.url().default(PAYPAL_SANDBOX_API),
  PAYPAL_PAYOUTS_ENABLED: z.enum(['true', 'false']).default('false'),
  PAYPAL_WEBHOOK_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  PAYPAL_WEBHOOK_CAPTURE_DIR: optionalSecret,
  PAYPAL_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(30_000),
  DEMO_ROLE_SWITCHER: z.enum(['true', 'false']).default('false'),
  OPENAI_API_KEY: optionalSecret,
  OPENAI_MODEL: optionalSecret,
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  OPENAI_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(45_000),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1_000).max(32_000).default(8_000),
  AI_DAILY_INVESTIGATION_LIMIT: z.coerce.number().int().min(1).max(1_000).default(50),
  DATABASE_PATH: z.string().trim().min(1).default('server/data/reliefrelay.db'),
});

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for a local stub server, which is the only non-HTTPS endpoint accepted. */
export function isLoopbackUrl(url: string): boolean {
  return LOOPBACK_HOSTS.has(new URL(url).hostname);
}

export type AppConfig = Readonly<{
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
  providerMode: 'simulation' | 'sandbox';
  paypal: {
    clientId?: string;
    clientSecret?: string;
    webhookId?: string;
    apiBaseUrl: string;
    /** The real PayPal Sandbox API, or a local stub on a loopback address (development and tests only). */
    target: PayPalTarget;
    /** Server-side switch for payment actions. Off unless explicitly enabled. */
    payoutsEnabled: boolean;
    webhookPort: number;
    /** Development only: where raw webhook deliveries are written for building a verification fixture. */
    webhookCaptureDir?: string;
    pollIntervalMs: number;
  };
  /** Development-only role demonstration switcher. Not authentication. */
  demoRoleSwitcher: boolean;
  openai: {
    apiKey?: string;
    model: string;
    baseUrl: string;
    reasoningEffort: 'low' | 'medium' | 'high';
    timeoutMs: number;
    maxOutputTokens: number;
    /** Investigation attempts allowed per organisation per UTC day. */
    dailyLimit: number;
  };
  /** SQLite file, resolved against the working directory. */
  databasePath: string;
  version: string;
}>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new ConfigError(`Invalid environment configuration. ${issues}`);
  }
  const env = parsed.data;

  const paypalUrl = new URL(env.PAYPAL_API_BASE_URL);
  const paypalLoopback = isLoopbackUrl(env.PAYPAL_API_BASE_URL);
  if (!paypalLoopback && !(paypalUrl.protocol === 'https:' && PAYPAL_SANDBOX_HOSTS.has(paypalUrl.hostname))) {
    throw new ConfigError('PAYPAL_API_BASE_URL must be the PayPal Sandbox API (https://api-m.sandbox.paypal.com). Live PayPal is not supported.');
  }
  if (paypalLoopback && env.NODE_ENV === 'production') {
    throw new ConfigError('PAYPAL_API_BASE_URL may only point at a local stub in development and test.');
  }
  if (env.PAYMENT_PROVIDER_MODE === 'sandbox') {
    if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
      throw new ConfigError('PAYMENT_PROVIDER_MODE=sandbox needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET from a PayPal Sandbox app.');
    }
    if (env.NODE_ENV === 'test' && !paypalLoopback) {
      throw new ConfigError('Automated tests may only use a local PayPal stub, never the real PayPal Sandbox.');
    }
  }
  if (env.DEMO_ROLE_SWITCHER === 'true' && env.NODE_ENV !== 'development') {
    throw new ConfigError('DEMO_ROLE_SWITCHER is a development-only role demonstration and is refused outside NODE_ENV=development.');
  }
  if (env.PAYPAL_WEBHOOK_CAPTURE_DIR && env.NODE_ENV !== 'development') {
    throw new ConfigError('PAYPAL_WEBHOOK_CAPTURE_DIR is only allowed in development.');
  }
  if (!env.OPENAI_BASE_URL.startsWith('https://') && !isLoopbackUrl(env.OPENAI_BASE_URL)) {
    throw new ConfigError('OPENAI_BASE_URL must use HTTPS.');
  }

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    providerMode: env.PAYMENT_PROVIDER_MODE,
    paypal: {
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      webhookId: env.PAYPAL_WEBHOOK_ID,
      apiBaseUrl: env.PAYPAL_API_BASE_URL.replace(/\/+$/, ''),
      target: (paypalLoopback ? 'local_stub' : 'paypal_sandbox') as PayPalTarget,
      payoutsEnabled: env.PAYPAL_PAYOUTS_ENABLED === 'true',
      webhookPort: env.PAYPAL_WEBHOOK_PORT,
      webhookCaptureDir: env.PAYPAL_WEBHOOK_CAPTURE_DIR ? resolve(env.PAYPAL_WEBHOOK_CAPTURE_DIR) : undefined,
      pollIntervalMs: env.PAYPAL_POLL_INTERVAL_MS,
    },
    demoRoleSwitcher: env.DEMO_ROLE_SWITCHER === 'true',
    openai: {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
      baseUrl: env.OPENAI_BASE_URL,
      reasoningEffort: env.OPENAI_REASONING_EFFORT,
      timeoutMs: env.AI_TIMEOUT_MS,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      dailyLimit: env.AI_DAILY_INVESTIGATION_LIMIT,
    },
    databasePath: resolve(env.DATABASE_PATH),
    version: process.env.npm_package_version ?? '0.1.0',
  });
}

/** Loads a local .env file when present. Real deployments inject environment variables directly. */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
