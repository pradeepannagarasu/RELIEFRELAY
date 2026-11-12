import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ApiErrorBody } from '@shared/api/contracts';
import { IMPORT_LIMITS } from '@shared/domain/imports';
import { AppError } from '../lib/errors';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError('not_found', `No API route matches ${req.method} ${req.path}`));
};

/** Body-parser failures carry a `type`; translate the ones clients can cause into safe API errors. */
function fromBodyParser(err: unknown): AppError | null {
  if (typeof err !== 'object' || err === null || !('type' in err)) return null;
  switch ((err as { type: unknown }).type) {
    case 'entity.too.large':
      return new AppError('payload_too_large', `The request is too large. CSV files may be at most ${IMPORT_LIMITS.maxBytes / (1024 * 1024)} MB.`);
    case 'entity.parse.failed':
      return new AppError('bad_request', 'The request body is not valid JSON.');
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return new AppError('unsupported_media_type', 'The request encoding is not supported.');
    default:
      return null;
  }
}

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const requestId = String(req.id ?? 'unknown');
  const appError = err instanceof AppError ? err : fromBodyParser(err);

  if (appError) {
    req.log.warn({ code: appError.code }, appError.message);
  } else {
    req.log.error({ err }, 'Unhandled error');
  }

  const body: ApiErrorBody = {
    error: {
      code: appError?.code ?? 'internal_error',
      message: appError?.message ?? 'Something went wrong on our side. The error has been logged.',
      requestId,
      ...(appError?.details !== undefined ? { details: appError.details } : {}),
    },
  };
  res.status(appError?.status ?? 500).json(body);
};
