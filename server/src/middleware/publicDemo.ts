import type { Request, RequestHandler } from 'express';
import type { User } from '@shared/domain/types';
import type { Db } from '../db/connection';
import { AppError } from '../lib/errors';
import { findUser } from '../repositories/sqlite/readModel';

/**
 * Set by the public demonstration gateway on every request it forwards; the gateway overwrites any value a visitor sends.
 * Sending it can only make a request more restricted, so a local client gains nothing by adding it.
 */
export const PUBLIC_GATEWAY_HEADER = 'x-reliefrelay-public-gateway';

const READ_METHODS = new Set(['GET', 'HEAD']);

export const PUBLIC_READ_ONLY_MESSAGE =
  'This is the public read-only demonstration. Approvals, payouts, cancellations, allowlist changes, imports, notes and role changes are not available here.';

export function isPublicDemoRequest(req: Request): boolean {
  return req.headers[PUBLIC_GATEWAY_HEADER] === '1';
}

/** Set by the public gateway in Judge Demo mode on every request it forwards. */
export const JUDGE_GATEWAY_HEADER = 'x-reliefrelay-judge-gateway';

/**
 * Refuses Judge Demo gateway traffic on any API that is not the Judge Demo. If the gateway were ever pointed at the
 * private PayPal Sandbox API by mistake, every request would be rejected instead of acting on genuine Sandbox data.
 */
export function judgeGatewayGuard(isJudgeDemo: boolean): RequestHandler {
  return (req, _res, next) => {
    if (!isJudgeDemo && req.headers[JUDGE_GATEWAY_HEADER] !== undefined) {
      return next(new AppError('forbidden', 'This API does not serve the public Judge Demo.'));
    }
    next();
  };
}

/** Rejects every change, and the role demonstration endpoints, for requests that arrived through the public gateway. */
export function publicReadOnlyGuard(): RequestHandler {
  return (req, _res, next) => {
    if (!isPublicDemoRequest(req)) return next();
    if (!READ_METHODS.has(req.method)) return next(new AppError('forbidden', PUBLIC_READ_ONLY_MESSAGE));
    if (/^\/demo(\/|$)/i.test(req.path)) return next(new AppError('forbidden', PUBLIC_READ_ONLY_MESSAGE));
    next();
  };
}

/** The organisation's read-only viewer account, which every public visitor acts as. */
export function findPublicViewer(db: Db, organisationId: string): User | null {
  const row = db.prepare("SELECT id FROM users WHERE organisation_id = ? AND role = 'viewer' ORDER BY id LIMIT 1").get(organisationId) as
    | { id: string }
    | undefined;
  return row ? findUser(db, row.id) : null;
}
