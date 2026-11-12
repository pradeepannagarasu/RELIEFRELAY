import type { RequestHandler } from 'express';
import type { Role, User } from '@shared/domain/types';
import { AppError } from '../lib/errors';
import type { Db } from '../db/connection';
import { findUser } from '../repositories/sqlite/readModel';
import { assertNoAdminRole, type SignedIdentityOptions } from '../judgeDemo/identity';
import { findPublicViewer, isPublicDemoRequest } from './publicDemo';

export interface Actor {
  user: User;
  organisationId: string;
}

declare global {
  namespace Express {
    interface Request {
      actor?: Actor;
    }
  }
}

export const DEMO_IDENTITY_COOKIE = 'rr_demo_user';
export const DEMO_WRITE_HEADER = 'x-reliefrelay-demo';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * Demo authentication: every request acts as the configured demo operator.
 * The Actor contract is what route handlers depend on, so a real identity provider
 * (mapped through users.external_auth_id) can replace this without touching routes.
 *
 * With the development-only role demonstration switcher enabled, a cookie may select another seeded account in the
 * same organisation. This is a role demonstration, not authentication. Writes under a switched identity must carry
 * the X-ReliefRelay-Demo header, which a cross-site form cannot add.
 *
 * Requests from the public demonstration gateway always act as the organisation's read-only viewer; cookies are ignored.
 *
 * In the Judge Demo (signedIdentity), the cookie must carry a server-made signature and may only select one of the
 * permitted roles; an unsigned, forged or out-of-role value is ignored and the request acts as the default account.
 */
export function demoAuthentication(
  db: Db,
  demoUserId: string,
  options: { roleSwitcher?: boolean; signedIdentity?: SignedIdentityOptions } = {},
): RequestHandler {
  const { signedIdentity } = options;
  if (signedIdentity) assertNoAdminRole(signedIdentity.roles);
  return (req, _res, next) => {
    const defaultUser = findUser(db, demoUserId);
    if (!defaultUser) return next(new AppError('unauthenticated', 'No active session.'));
    if (signedIdentity && !signedIdentity.roles.includes(defaultUser.role)) return next(new AppError('forbidden', 'The default demo account is not permitted.'));
    if (isPublicDemoRequest(req)) {
      const viewer = findPublicViewer(db, defaultUser.organisationId);
      if (!viewer) return next(new AppError('forbidden', 'The public demonstration has no read-only account configured.'));
      req.actor = { user: viewer, organisationId: viewer.organisationId };
      return next();
    }
    let user = defaultUser;
    if (options.roleSwitcher || signedIdentity) {
      const raw = readCookie(req.headers.cookie, DEMO_IDENTITY_COOKIE);
      const selected = signedIdentity ? signedIdentity.signer.verify(raw) : raw;
      if (selected && selected !== defaultUser.id) {
        const candidate = findUser(db, selected);
        if (
          candidate &&
          candidate.organisationId === defaultUser.organisationId &&
          (!signedIdentity || signedIdentity.roles.includes(candidate.role))
        ) {
          if (!SAFE_METHODS.has(req.method) && req.headers[DEMO_WRITE_HEADER] !== '1') {
            return next(new AppError('forbidden', 'Changes under a demonstration identity must come from the ReliefRelay app.'));
          }
          user = candidate;
        }
      }
    }
    req.actor = { user, organisationId: user.organisationId };
    next();
  };
}

export function requireActor(req: Express.Request): Actor {
  if (!req.actor) throw new AppError('unauthenticated', 'No active session.');
  return req.actor;
}

export function requireRole(...allowed: Role[]): RequestHandler {
  return (req, _res, next) => {
    const actor = requireActor(req);
    if (!allowed.includes(actor.user.role)) {
      return next(new AppError('forbidden', `This action requires one of the roles: ${allowed.join(', ')}.`));
    }
    next();
  };
}
