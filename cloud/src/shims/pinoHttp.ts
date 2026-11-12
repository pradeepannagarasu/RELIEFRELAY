import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShimLogger } from './pino';

/** Minimal pino-http replacement: request id, req.log, and one log line per completed request (path only, no query). */
interface Options {
  logger: ShimLogger;
  genReqId?: (req: IncomingMessage, res: ServerResponse) => string;
  customLogLevel?: (req: IncomingMessage, res: ServerResponse, err?: unknown) => 'info' | 'warn' | 'error';
}

export function pinoHttp(options: Options) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const id = options.genReqId?.(req, res) ?? '';
    Object.assign(req, { id, log: options.logger.child({ reqId: id }) });
    const started = Date.now();
    res.on('finish', () => {
      const level = options.customLogLevel?.(req, res) ?? 'info';
      options.logger[level]({ req: { id, method: req.method, url: (req.url ?? '').split('?')[0] }, res: { statusCode: res.statusCode }, responseTime: Date.now() - started }, 'request completed');
    });
    next();
  };
}

export default pinoHttp;
