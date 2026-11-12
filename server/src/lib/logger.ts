import pino, { type Logger } from 'pino';
import type { AppConfig } from '../config/env';

/** Paths that must never reach log output. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["paypal-auth-algo"]',
  'req.headers["paypal-transmission-sig"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.secret',
  '*.clientSecret',
  '*.apiKey',
  '*.accessToken',
  '*.recipientEmail',
];

export function createLogger(config: Pick<AppConfig, 'logLevel' | 'nodeEnv'>): Logger {
  return pino({
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'reliefrelay-api' },
    ...(config.nodeEnv === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' } } }
      : {}),
  });
}
