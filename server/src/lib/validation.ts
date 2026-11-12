import type { Request } from 'express';
import type { z } from 'zod';
import type { RequestContext } from '../services/context';
import { requireActor } from '../middleware/auth';
import { AppError } from './errors';

/** Parses untrusted input, turning schema failures into a 422 that names each invalid field. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown, what = 'request'): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AppError(
    'validation_failed',
    `The ${what} is invalid.`,
    { fields: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
  );
}

export function requestContext(req: Request): RequestContext {
  return { actor: requireActor(req), requestId: req.id ? String(req.id) : null };
}
