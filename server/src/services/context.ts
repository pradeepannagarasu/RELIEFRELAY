import type { Role } from '@shared/domain/types';
import { appendAudit, type AuditActor } from '../audit/auditLog';
import { isBusyError, type Db } from '../db/connection';
import { AppError } from '../lib/errors';
import type { Actor } from '../middleware/auth';

/** Who is acting and which request they are acting in. Every service call receives one. */
export interface RequestContext {
  actor: Actor;
  requestId: string | null;
}

export const auditActor = (ctx: RequestContext): AuditActor => ({ type: 'user', userId: ctx.actor.user.id, role: ctx.actor.user.role });

/** Records a refused action in the audit log, outside any rolled-back transaction. */
export function auditRejection(
  db: Db,
  ctx: RequestContext,
  action: string,
  entityType: string,
  entityId: string | null,
  reason: string,
  newState?: unknown,
): void {
  appendAudit(db, {
    organisationId: ctx.actor.organisationId,
    actor: auditActor(ctx),
    action,
    entityType,
    entityId,
    outcome: 'rejected',
    requestId: ctx.requestId,
    reason: reason.slice(0, 500),
    newState,
  });
}

/** Role check that also leaves an audit trail of the refusal. */
export function assertRole(db: Db, ctx: RequestContext, allowed: Role[], action: string, entityType: string, entityId: string | null): void {
  if (allowed.includes(ctx.actor.user.role)) return;
  const message = `This action requires one of the roles: ${allowed.join(', ')}.`;
  auditRejection(db, ctx, action, entityType, entityId, `Role ${ctx.actor.user.role} is not permitted. ${message}`);
  throw new AppError('forbidden', message);
}

/** Translates a lock timeout into a clear, retryable API error. Nothing was written when this happens. */
export function rethrowBusy(error: unknown): never {
  if (isBusyError(error)) {
    throw new AppError('service_unavailable', 'The database is busy with another change. Nothing was saved; please try again.');
  }
  throw error;
}
