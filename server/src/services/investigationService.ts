import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { EvidenceSourceRef, InvestigationDetail, InvestigationListResponse, InvestigationSummary } from '@shared/api/contracts';
import { isCaseActive } from '@shared/domain/cases';
import {
  FAILURE_INFO,
  INVESTIGATION_SCHEMA_VERSION,
  type EvidencePack,
  type InvestigationFailureCode,
  type InvestigationResult,
  type InvestigationStatus,
  type ValidationIssue,
} from '@shared/domain/investigation';
import { investigationJsonSchema } from '@shared/domain/investigationSchema';
import type { CaseState, Role } from '@shared/domain/types';
import { buildEvidencePack, type BuiltEvidencePack } from '../ai/evidencePack';
import { INVESTIGATION_INSTRUCTIONS, PROMPT_VERSION } from '../ai/prompt';
import type { AiProvider, AiResponse } from '../ai/provider';
import { validateInvestigationOutput } from '../ai/validator';
import { appendAudit } from '../audit/auditLog';
import { isBusyError, type Db } from '../db/connection';
import { AppError } from '../lib/errors';
import { findUser } from '../repositories/sqlite/readModel';
import { assertRole, auditActor, auditRejection, rethrowBusy, type RequestContext } from './context';

/**
 * Runs AI-assisted investigations. This service writes only to case_investigations and audit_events; payment,
 * case, finding, note and event records are read, never modified.
 */

export interface InvestigationService {
  list(ctx: RequestContext, caseId: string): InvestigationListResponse;
  get(ctx: RequestContext, caseId: string, investigationId: string): InvestigationDetail;
  run(ctx: RequestContext, caseId: string, caseVersion: number): Promise<InvestigationDetail>;
  /** Marks attempts left pending by a previous server process as interrupted. */
  recoverInterrupted(): number;
}

export interface InvestigationServiceOptions {
  db: Db;
  clock: () => Date;
  provider: AiProvider | null;
  dailyLimit: number;
  timeoutMs: number;
  logger?: Logger;
}

export const RUN_ROLES: Role[] = ['operator', 'admin'];
const SCHEMA_NAME = 'case_investigation';

interface InvestigationRow {
  id: string;
  organisation_id: string;
  case_id: string;
  case_version: number;
  requested_by_user_id: string;
  requested_at: string;
  status: InvestigationStatus;
  model_requested: string;
  model_reported: string | null;
  prompt_version: string;
  evidence_pack: string;
  evidence_fingerprint: string;
  evidence_count: number;
  evidence_sources: string;
  result: string | null;
  failure_code: InvestigationFailureCode | null;
  failure_detail: string | null;
  validation_issues: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  completed_at: string | null;
}

interface Completion {
  status: 'succeeded' | 'failed';
  result: InvestigationResult | null;
  failureCode: InvestigationFailureCode | null;
  failureDetail: string | null;
  issues: ValidationIssue[] | null;
  modelReported: string | null;
  responseId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
}

const startOfUtcDay = (date: Date) => `${date.toISOString().slice(0, 10)}T00:00:00.000Z`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createInvestigationService({ db, clock, provider, dailyLimit, timeoutMs, logger }: InvestigationServiceOptions): InvestigationService {
  const loadCase = (ctx: RequestContext, caseId: string) => {
    const row = db.prepare('SELECT id, state, version FROM payment_cases WHERE id = ? AND organisation_id = ?').get(caseId, ctx.actor.organisationId) as
      | { id: string; state: CaseState; version: number }
      | undefined;
    if (!row) throw new AppError('not_found', 'Case not found.');
    return row;
  };

  const usedToday = (organisationId: string) =>
    (db.prepare('SELECT count(*) AS n FROM case_investigations WHERE organisation_id = ? AND requested_at >= ?').get(organisationId, startOfUtcDay(clock())) as { n: number }).n;

  const currentPack = (ctx: RequestContext, caseId: string): BuiltEvidencePack => {
    const built = buildEvidencePack(db, ctx.actor.organisationId, caseId, clock());
    if (!built) throw new AppError('not_found', 'Case not found.');
    return built;
  };

  const summarise = (row: InvestigationRow, currentFingerprint: string): InvestigationSummary => {
    const user = findUser(db, row.requested_by_user_id);
    return {
      id: row.id,
      status: row.status,
      requestedAt: row.requested_at,
      completedAt: row.completed_at,
      requestedBy: { id: row.requested_by_user_id, displayName: user?.displayName ?? 'Unknown user' },
      model: row.model_reported ?? row.model_requested,
      promptVersion: row.prompt_version,
      caseVersion: row.case_version,
      evidenceCount: row.evidence_count,
      evidenceFingerprint: row.evidence_fingerprint,
      evidenceChanged: row.evidence_fingerprint !== currentFingerprint,
      failure: row.failure_code ? { code: row.failure_code, ...FAILURE_INFO[row.failure_code], detail: row.failure_detail } : null,
    };
  };

  const toDetail = (row: InvestigationRow, currentFingerprint: string): InvestigationDetail => {
    const pack = JSON.parse(row.evidence_pack) as EvidencePack;
    const sources = JSON.parse(row.evidence_sources) as Record<string, EvidenceSourceRef>;
    return {
      ...summarise(row, currentFingerprint),
      result: row.result ? (JSON.parse(row.result) as InvestigationResult) : null,
      validationIssues: row.validation_issues ? (JSON.parse(row.validation_issues) as ValidationIssue[]) : [],
      evidence: pack.evidence.map((item) => ({ ...item, source: sources[item.id] ?? null })),
      evidenceAsOf: pack.asOf,
      withheld: pack.withheld,
      usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens, latencyMs: row.latency_ms },
    };
  };

  const loadRow = (investigationId: string) => db.prepare('SELECT * FROM case_investigations WHERE id = ?').get(investigationId) as InvestigationRow | undefined;

  /** Writes the outcome of an attempt. Retries briefly if the database is busy so a finished call is not lost. */
  const complete = async (ctx: RequestContext | null, organisationId: string, caseId: string, investigationId: string, outcome: Completion) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        db.transaction(() => {
          const changed = db
            .prepare(
              `UPDATE case_investigations SET status = @status, result = @result, failure_code = @failureCode, failure_detail = @failureDetail,
                 validation_issues = @issues, model_reported = @modelReported, provider_response_id = @responseId, input_tokens = @inputTokens,
                 output_tokens = @outputTokens, latency_ms = @latencyMs, completed_at = @completedAt
               WHERE id = @id AND status = 'pending'`,
            )
            .run({
              id: investigationId,
              status: outcome.status,
              result: outcome.result ? JSON.stringify(outcome.result) : null,
              failureCode: outcome.failureCode,
              failureDetail: outcome.failureDetail,
              issues: outcome.issues ? JSON.stringify(outcome.issues) : null,
              modelReported: outcome.modelReported,
              responseId: outcome.responseId,
              inputTokens: outcome.inputTokens,
              outputTokens: outcome.outputTokens,
              latencyMs: outcome.latencyMs,
              completedAt: clock().toISOString(),
            }).changes;
          if (changed === 0) return;
          appendAudit(db, {
            organisationId,
            actor: ctx ? auditActor(ctx) : { type: 'system' },
            action: 'case.investigation_completed',
            entityType: 'payment_case',
            entityId: caseId,
            outcome: 'succeeded',
            requestId: ctx?.requestId ?? null,
            newState: {
              investigationId,
              status: outcome.status,
              failureCode: outcome.failureCode,
              model: outcome.modelReported,
              inputTokens: outcome.inputTokens,
              outputTokens: outcome.outputTokens,
              issueCodes: outcome.issues ? [...new Set(outcome.issues.map((i) => i.code))] : undefined,
            },
          });
        }).immediate();
        return;
      } catch (error) {
        if (!isBusyError(error) || attempt >= 5) throw error;
        await sleep(200 * attempt);
      }
    }
  };

  const interruptedOutcome: Completion = {
    status: 'failed',
    result: null,
    failureCode: 'interrupted',
    failureDetail: 'The server stopped before this attempt finished.',
    issues: null,
    modelReported: null,
    responseId: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
  };

  const markInterrupted = (rows: { id: string; organisation_id: string; case_id: string }[]) => {
    for (const row of rows) {
      const changed = db
        .prepare(
          "UPDATE case_investigations SET status = 'failed', failure_code = 'interrupted', failure_detail = ?, completed_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(interruptedOutcome.failureDetail, clock().toISOString(), row.id).changes;
      if (changed === 0) continue;
      appendAudit(db, {
        organisationId: row.organisation_id,
        actor: { type: 'system' },
        action: 'case.investigation_completed',
        entityType: 'payment_case',
        entityId: row.case_id,
        outcome: 'succeeded',
        newState: { investigationId: row.id, status: 'failed', failureCode: 'interrupted' },
      });
    }
    return rows.length;
  };

  const toCompletion = (response: AiResponse, pack: EvidencePack, latencyMs: number): Completion => {
    const base = { modelReported: response.model, responseId: response.responseId, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, latencyMs };
    if (!response.ok) {
      return { ...base, status: 'failed', result: null, failureCode: response.failure, failureDetail: response.detail, issues: null };
    }
    const validation = validateInvestigationOutput(response.output, pack);
    if (!validation.ok) {
      return {
        ...base,
        status: 'failed',
        result: null,
        failureCode: 'failed_validation',
        failureDetail: `${validation.issues.length} check${validation.issues.length === 1 ? '' : 's'} failed.`,
        issues: validation.issues,
      };
    }
    return { ...base, status: 'succeeded', result: validation.result, failureCode: null, failureDetail: null, issues: null };
  };

  return {
    list(ctx, caseId) {
      const caseRow = loadCase(ctx, caseId);
      const pack = currentPack(ctx, caseId);
      const rows = db.prepare('SELECT * FROM case_investigations WHERE case_id = ? ORDER BY requested_at DESC, rowid DESC').all(caseId) as InvestigationRow[];
      const used = usedToday(ctx.actor.organisationId);
      const role = ctx.actor.user.role;
      const reason = !provider
        ? 'AI-assisted investigation is not configured on this server.'
        : !RUN_ROLES.includes(role)
          ? 'Only operators and administrators can run an investigation.'
          : !isCaseActive(caseRow.state)
            ? 'Resolved and closed cases cannot be investigated.'
            : rows.some((r) => r.status === 'pending')
              ? 'An investigation for this case is in progress.'
              : used >= dailyLimit
                ? `Your organisation has reached its limit of ${dailyLimit} investigations today.`
                : null;
      const succeeded = rows.find((r) => r.status === 'succeeded');
      return {
        availability: { configured: provider !== null, model: provider?.model ?? null, canRun: reason === null, reason, dailyLimit, usedToday: used },
        current: { evidenceFingerprint: pack.fingerprint, evidenceCount: pack.pack.evidence.length },
        investigations: rows.map((r) => summarise(r, pack.fingerprint)),
        latestSucceeded: succeeded ? toDetail(succeeded, pack.fingerprint) : null,
      };
    },

    get(ctx, caseId, investigationId) {
      loadCase(ctx, caseId);
      const row = loadRow(investigationId);
      if (!row || row.case_id !== caseId || row.organisation_id !== ctx.actor.organisationId) throw new AppError('not_found', 'Investigation not found.');
      return toDetail(row, currentPack(ctx, caseId).fingerprint);
    },

    async run(ctx, caseId, caseVersion) {
      const action = 'case.investigation_requested';
      assertRole(db, ctx, RUN_ROLES, action, 'payment_case', caseId);
      if (!provider) {
        auditRejection(db, ctx, action, 'payment_case', caseId, 'AI-assisted investigation is not configured.');
        throw new AppError('service_unavailable', 'AI-assisted investigation is not configured on this server.', { reason: 'not_configured' });
      }

      const investigationId = `inv_${randomUUID()}`;
      let built: BuiltEvidencePack;
      try {
        built = db
          .transaction(() => {
            const caseRow = loadCase(ctx, caseId);
            if (!isCaseActive(caseRow.state)) {
              throw new AppError('validation_failed', 'Only active cases can be investigated. Resolved and closed cases are excluded.', { reason: 'case_not_active' });
            }
            if (caseRow.version !== caseVersion) {
              throw new AppError('conflict', 'This case changed since you opened it. Review the latest details before running an investigation.', {
                reason: 'stale_version',
                currentVersion: caseRow.version,
              });
            }
            const staleBefore = new Date(clock().getTime() - 2 * timeoutMs - 60_000).toISOString();
            markInterrupted(
              db.prepare("SELECT id, organisation_id, case_id FROM case_investigations WHERE case_id = ? AND status = 'pending' AND requested_at < ?").all(caseId, staleBefore) as {
                id: string;
                organisation_id: string;
                case_id: string;
              }[],
            );
            if (db.prepare("SELECT 1 FROM case_investigations WHERE case_id = ? AND status = 'pending'").get(caseId)) {
              throw new AppError('conflict', 'An investigation for this case is already in progress.', { reason: 'in_progress' });
            }
            if (usedToday(ctx.actor.organisationId) >= dailyLimit) {
              throw new AppError('too_many_requests', `Your organisation has reached its limit of ${dailyLimit} investigations today. The limit resets at midnight UTC.`, {
                reason: 'daily_limit',
              });
            }
            const pack = currentPack(ctx, caseId);
            db.prepare(
              `INSERT INTO case_investigations (id, organisation_id, case_id, case_version, requested_by_user_id, requested_at, provider, model_requested,
                 prompt_version, schema_version, evidence_pack, evidence_fingerprint, evidence_count, evidence_sources)
               VALUES (?, ?, ?, ?, ?, ?, 'openai', ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              investigationId,
              ctx.actor.organisationId,
              caseId,
              caseRow.version,
              ctx.actor.user.id,
              clock().toISOString(),
              provider.model,
              PROMPT_VERSION,
              INVESTIGATION_SCHEMA_VERSION,
              pack.json,
              pack.fingerprint,
              pack.pack.evidence.length,
              JSON.stringify(pack.sources),
            );
            appendAudit(db, {
              organisationId: ctx.actor.organisationId,
              actor: auditActor(ctx),
              action,
              entityType: 'payment_case',
              entityId: caseId,
              outcome: 'succeeded',
              requestId: ctx.requestId,
              newState: {
                investigationId,
                model: provider.model,
                promptVersion: PROMPT_VERSION,
                evidenceCount: pack.pack.evidence.length,
                evidenceFingerprint: pack.fingerprint,
              },
            });
            return pack;
          })
          .immediate();
      } catch (error) {
        if (error instanceof AppError) auditRejection(db, ctx, action, 'payment_case', caseId, error.message);
        rethrowBusy(error);
      }

      // The attempt is recorded. From here it always reaches a final status, even if the browser disconnects.
      const started = Date.now();
      let response: AiResponse;
      try {
        response = await provider.investigate({ instructions: INVESTIGATION_INSTRUCTIONS, evidence: built.json, schemaName: SCHEMA_NAME, schema: investigationJsonSchema() });
      } catch {
        response = { ok: false, failure: 'provider_unavailable', detail: 'The AI provider request failed unexpectedly.', model: null, responseId: null, usage: { inputTokens: null, outputTokens: null } };
      }
      const outcome = toCompletion(response, built.pack, Date.now() - started);
      await complete(ctx, ctx.actor.organisationId, caseId, investigationId, outcome);
      logger?.info(
        { investigationId, status: outcome.status, failureCode: outcome.failureCode, latencyMs: outcome.latencyMs, inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens },
        'Investigation attempt finished',
      );
      if (!response.ok && response.failure === 'rate_limited' && response.retryAfterSeconds !== undefined) {
        logger?.warn({ investigationId, retryAfterSeconds: response.retryAfterSeconds }, 'AI provider rate limit reached');
      }
      return toDetail(loadRow(investigationId)!, currentPack(ctx, caseId).fingerprint);
    },

    recoverInterrupted() {
      return db
        .transaction(() =>
          markInterrupted(db.prepare("SELECT id, organisation_id, case_id FROM case_investigations WHERE status = 'pending'").all() as { id: string; organisation_id: string; case_id: string }[]),
        )
        .immediate();
    },
  };
}
