import { Router } from 'express';
import { z } from 'zod';
import type { DemoIdentitiesResponse } from '@shared/api/contracts';
import { appendAudit } from '../audit/auditLog';
import type { Db } from '../db/connection';
import type { SignedIdentityOptions } from '../judgeDemo/identity';
import { AppError } from '../lib/errors';
import { parseInput, requestContext } from '../lib/validation';
import { DEMO_IDENTITY_COOKIE, DEMO_WRITE_HEADER } from '../middleware/auth';
import { findUser } from '../repositories/sqlite/readModel';
import { auditActor, auditRejection } from '../services/context';

export const DEMO_IDENTITY_NOTICE =
  'Role demonstration: switch between seeded demo accounts to show who can propose and who can approve. This is not authentication or production-grade four-eyes security.';

export const JUDGE_IDENTITY_NOTICE =
  'Judge Demo identities: act as the operator who proposes a recovery, then switch to a different approver to review it. The server assigns and signs these identities; the administrator role is not available here. This is a demonstration, not authentication.';

const SwitchBody = z.strictObject({ userId: z.string().regex(/^usr_[a-z0-9_]{1,40}$/) });

/**
 * Role demonstration switcher. Mounted when DEMO_ROLE_SWITCHER is enabled in development, or in the Judge Demo with
 * signed identities limited to the permitted roles.
 */
export function demoRouter(db: Db, demoUserId: string, signed?: SignedIdentityOptions): Router {
  const router = Router();
  const notice = signed ? JUDGE_IDENTITY_NOTICE : DEMO_IDENTITY_NOTICE;

  const identities = (organisationId: string) =>
    (db.prepare('SELECT id, display_name, role FROM users WHERE organisation_id = ? ORDER BY id').all(organisationId) as { id: string; display_name: string; role: DemoIdentitiesResponse['identities'][number]['role'] }[])
      .filter((u) => !signed || signed.roles.includes(u.role))
      .map((u) => ({ id: u.id, displayName: u.display_name, role: u.role }));

  router.get('/identities', (req, res) => {
    const ctx = requestContext(req);
    const body: DemoIdentitiesResponse = { notice, currentUserId: ctx.actor.user.id, identities: identities(ctx.actor.organisationId) };
    res.json(body);
  });

  router.post('/identity', (req, res) => {
    const ctx = requestContext(req);
    if (req.headers[DEMO_WRITE_HEADER] !== '1') throw new AppError('forbidden', 'Switching identity must come from the ReliefRelay app.');
    const { userId } = parseInput(SwitchBody, req.body, 'identity');
    const target = findUser(db, userId);
    if (!target || target.organisationId !== ctx.actor.organisationId) throw new AppError('not_found', 'No such demo account in this organisation.');
    if (signed && !signed.roles.includes(target.role)) {
      auditRejection(db, ctx, 'demo.identity_switched', 'user', target.id, `The ${target.role} role is not available in the Judge Demo.`);
      throw new AppError('forbidden', `The ${target.role} role is not available in the Judge Demo.`);
    }
    appendAudit(db, {
      organisationId: ctx.actor.organisationId,
      actor: auditActor(ctx),
      action: 'demo.identity_switched',
      entityType: 'user',
      entityId: target.id,
      outcome: 'succeeded',
      requestId: ctx.requestId,
      previousState: { userId: ctx.actor.user.id, role: ctx.actor.user.role },
      newState: { userId: target.id, role: target.role },
      reason: signed ? 'Judge Demo identity assigned by the server. Not authentication.' : 'Development-only role demonstration. Not authentication.',
    });
    if (target.id === demoUserId) res.clearCookie(DEMO_IDENTITY_COOKIE, { path: '/' });
    else res.cookie(DEMO_IDENTITY_COOKIE, signed ? signed.signer.sign(target.id) : target.id, { httpOnly: true, sameSite: 'strict', path: '/' });
    const body: DemoIdentitiesResponse = { notice, currentUserId: target.id, identities: identities(ctx.actor.organisationId) };
    res.json(body);
  });

  return router;
}
