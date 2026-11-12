import { randomUUID } from 'node:crypto';
import type {
  ApproveProposalRequest,
  CreateProposalRequest,
  DecideProposalRequest,
  PaymentActionsResponse,
  ProposalDetail,
  ProposalListResponse,
  ReconcileRequest,
  ServerCheck,
  StatusCheckResponse,
} from '@shared/api/contracts';
import { confirmationPhrase, PAYOUT_LIMITS, PROPOSAL_REASON_INFO, PROPOSAL_STATUSES, SANDBOX_NOTICE, type PayoutCurrency } from '@shared/domain/payouts';
import { formatMoney, money, type CurrencyCode } from '@shared/domain/money';
import type { Role } from '@shared/domain/types';
import { listAuditEventsForEntity, type AuditEventRow } from '../audit/auditLog';
import { sha256Hex } from '../db/connection';
import { findContactDetails } from '../imports/privacy';
import { AppError } from '../lib/errors';
import { PAYPAL_ID } from '../paypal/client';
import { buildPayoutRequest } from '../paypal/requestBuilder';
import { assertRole, auditActor, auditRejection, rethrowBusy, type RequestContext } from '../services/context';
import type { CancellationService } from './cancellations';
import { CANCEL_REASON_CODES, evaluateCase, REISSUE_REASON_CODES, type Evaluation, type PayoutEnvironment } from './eligibility';
import {
  addMs,
  DAY,
  HOUR,
  loadCancellation,
  loadCase,
  loadItem,
  loadProposal,
  loadSubmission,
  transitionCase,
  type CancellationRow,
  type DiscrepancyRow,
  type ProposalRow,
  type SubmissionRow,
} from './records';
import { fetchItemStatus, providerItemIdFor, restoreCaseAfterProposal, SANDBOX_SUFFIX, type PayoutDeps } from './statusSync';
import type { SubmissionService } from './submissions';
import { auditPayout, targetText } from './target';
import {
  attemptView,
  auditEntryView,
  cancellationView,
  discrepancyView,
  limitUsage,
  proposalSummary,
  reconciliationView,
  statusCheckView,
  submissionView,
} from './views';

const PROPOSE_ROLES: Role[] = ['operator', 'admin'];
const DECIDE_ROLES: Role[] = ['approver', 'admin'];
const CHECK_ROLES: Role[] = ['operator', 'approver', 'admin'];
const ADMIN: Role[] = ['admin'];
const MANUAL_CHECK_INTERVAL_MS = 10_000;

export interface PayoutServiceDeps extends PayoutDeps {
  environment: () => PayoutEnvironment;
  submissions: SubmissionService;
  cancellations: CancellationService;
}

const normaliseConfirmation = (value: string) => value.trim().replace(/\s+/g, ' ');

export function createPayoutService(deps: PayoutServiceDeps) {
  const { db, clock, submissions, cancellations } = deps;

  const ownCase = (ctx: RequestContext, caseId: string) => {
    const row = loadCase(db, caseId);
    if (!row || row.organisation_id !== ctx.actor.organisationId) throw new AppError('not_found', 'Case not found.');
    return row;
  };
  const ownProposal = (ctx: RequestContext, id: string) => {
    const row = loadProposal(db, id);
    if (!row || row.organisation_id !== ctx.actor.organisationId) throw new AppError('not_found', 'Proposal not found.');
    return row;
  };

  const evaluate = (caseId: string, ignoreProposalId?: string) => evaluateCase(db, loadCase(db, caseId)!, deps.environment(), clock(), { ignoreProposalId });

  /** Runs a write and records a refusal in the audit log if it fails with an AppError. */
  const guarded = <T>(ctx: RequestContext, action: string, entityType: string, entityId: string | null, fn: () => T): T => {
    try {
      return db.transaction(fn).immediate();
    } catch (error) {
      if (error instanceof AppError) auditRejection(db, ctx, action, entityType, entityId, error.message, error.details);
      rethrowBusy(error);
    }
  };

  function expireIfDue(proposal: ProposalRow): ProposalRow {
    if (proposal.status !== 'pending_approval' || clock().toISOString() < proposal.expires_at) return proposal;
    db.transaction(() => {
      const current = loadProposal(db, proposal.id)!;
      if (current.status !== 'pending_approval') return;
      const at = clock().toISOString();
      db.prepare("UPDATE payout_proposals SET status = 'expired', decided_at = ?, decision_reason = ?, version = version + 1 WHERE id = ?").run(
        at,
        `No decision within ${PAYOUT_LIMITS.proposalExpiryHours} hours.`,
        current.id,
      );
      auditPayout(db, {
        organisationId: current.organisation_id,
        actor: { type: 'system' },
        action: 'payout.proposal_expired',
        entityType: 'payout_proposal',
        entityId: current.id,
        outcome: 'succeeded',
        previousState: { status: 'pending_approval', version: current.version },
        newState: { status: 'expired', version: current.version + 1 },
        reason: `No decision within ${PAYOUT_LIMITS.proposalExpiryHours} hours. Nothing was sent.`,
      });
      restoreCaseAfterProposal(db, loadProposal(db, current.id)!, at, { type: 'system' }, null, `Proposal expired after ${PAYOUT_LIMITS.proposalExpiryHours} hours without a decision. Nothing was sent.`);
    }).immediate();
    return loadProposal(db, proposal.id)!;
  }

  function serverChecks(ctx: RequestContext, proposal: ProposalRow, ev: Evaluation): ServerCheck[] {
    const env = ev.blocks.filter((b) => ['simulation_mode', 'not_configured', 'payouts_disabled'].includes(b.code));
    const other = ev.blocks.filter((b) => !env.includes(b));
    const option = proposal.action === 'reissue' ? ev.reissue : ev.cancel;
    const checks: ServerCheck[] = [
      {
        code: 'four_eyes',
        label: 'Decided by someone other than the proposer',
        passed: ctx.actor.user.id !== proposal.proposed_by_user_id,
        detail: ctx.actor.user.id === proposal.proposed_by_user_id ? 'You proposed this action, so you cannot decide it.' : 'You did not propose this action.',
      },
      {
        code: 'role',
        label: 'Approver or administrator role',
        passed: DECIDE_ROLES.includes(ctx.actor.user.role),
        detail: `Your role is ${ctx.actor.user.role}.`,
      },
      {
        code: 'not_expired',
        label: 'Proposal has not expired',
        passed: clock().toISOString() < proposal.expires_at,
        detail: `Expires ${proposal.expires_at.slice(0, 16).replace('T', ' ')} UTC.`,
      },
      {
        code: 'sandbox_environment',
        label: 'PayPal Sandbox mode with payment actions switched on',
        passed: env.length === 0,
        detail: env.length ? env.map((b) => b.message).join(' ') : 'This server is in PayPal Sandbox mode and payment actions are on.',
      },
      {
        code: 'no_blocks',
        label: 'No unresolved requests, discrepancies or reconciliation',
        passed: other.length === 0,
        detail: other.length ? other.map((b) => b.message).join(' ') : 'Nothing else is in progress for this payment.',
      },
      {
        code: 'provider_unchanged',
        label: 'Provider statuses unchanged since the proposal',
        passed: ev.fingerprint === proposal.provider_fingerprint,
        detail: ev.fingerprint === proposal.provider_fingerprint ? 'The provider statuses match what the proposer saw.' : 'A provider status changed after the proposal was made.',
      },
      {
        code: 'eligible',
        label: proposal.action === 'reissue' ? 'Reissue rules met' : 'Cancellation rules met',
        passed: option.reasons.length === 0 && option.target?.item.id === proposal.target_item_id,
        detail: option.reasons.length ? option.reasons.join(' ') : 'The provider status and case state allow this action.',
      },
    ];
    if (proposal.action === 'reissue') {
      checks.push({
        code: 'allowlist',
        label: 'Receiver is an exact, active entry on the reserved receiver allowlist',
        passed: !!ev.reissue.allowlistEntry && ev.reissue.allowlistEntry.id === proposal.allowlist_entry_id,
        detail: ev.reissue.allowlistEntry ? `Allowlisted as "${ev.reissue.allowlistEntry.label}".` : 'The receiver is not on the active allowlist.',
      });
      const usage = limitUsage(db, proposal.organisation_id, proposal.currency as PayoutCurrency, clock());
      const withinCount = usage.payoutsToday + 1 <= usage.maxPayoutsPerDay;
      const withinValue = usage.valueTodayMinor + proposal.amount_minor <= usage.maxValuePerCurrencyPerDayMinor;
      checks.push({
        code: 'limits',
        label: 'Within the daily limits',
        passed: withinCount && withinValue && proposal.amount_minor <= usage.maxPerPayoutMinor,
        detail: `${usage.payoutsToday} of ${usage.maxPayoutsPerDay} payouts approved today; ${formatMoney(money(usage.currency, usage.valueTodayMinor))} of ${formatMoney(money(usage.currency, usage.maxValuePerCurrencyPerDayMinor))} approved today in ${usage.currency}.`,
      });
    }
    if (option.statusCheckRequired) {
      checks.push({
        code: 'fresh_status',
        label: 'Fresh PayPal Sandbox status',
        passed: true,
        detail: 'The status will be fetched from PayPal Sandbox when you approve, and approval stops if it has changed.',
      });
    }
    return checks;
  }

  function history(proposal: ProposalRow, submission: SubmissionRow | undefined, cancellation: CancellationRow | undefined) {
    const rows: AuditEventRow[] = [
      ...listAuditEventsForEntity(db, 'payout_proposal', proposal.id),
      ...(submission ? listAuditEventsForEntity(db, 'payout_submission', submission.id) : []),
      ...(cancellation ? listAuditEventsForEntity(db, 'payout_cancellation', cancellation.id) : []),
    ];
    return rows.sort((a, b) => a.seq - b.seq).map((row) => auditEntryView(db, row));
  }

  function proposalDetail(ctx: RequestContext, id: string): ProposalDetail {
    const proposal = expireIfDue(ownProposal(ctx, id));
    const caseRow = loadCase(db, proposal.case_id)!;
    const pending = proposal.status === 'pending_approval';
    const ev = evaluate(proposal.case_id, pending ? proposal.id : undefined);
    const submission = db.prepare('SELECT * FROM payout_submissions WHERE proposal_id = ?').get(proposal.id) as SubmissionRow | undefined;
    const cancellation = db.prepare('SELECT * FROM payout_cancellations WHERE proposal_id = ?').get(proposal.id) as CancellationRow | undefined;
    const target = loadItem(db, proposal.target_item_id)!;
    const checks = pending ? serverChecks(ctx, proposal, ev) : [];
    const isProposer = ctx.actor.user.id === proposal.proposed_by_user_id;
    const canDecideRole = DECIDE_ROLES.includes(ctx.actor.user.role);
    const failing = checks.filter((c) => !c.passed);
    let reason: string | null = null;
    if (!pending) reason = 'This proposal has already been decided.';
    else if (!canDecideRole) reason = 'Only an approver or administrator can decide payment actions.';
    else if (isProposer) reason = 'You proposed this action. A different approver must decide it.';
    else if (failing.length) reason = failing.map((c) => c.detail).join(' ');
    return {
      ...proposalSummary(db, proposal),
      justification: proposal.justification,
      decisionReason: proposal.decision_reason,
      target: { id: target.id, reference: target.payment_reference },
      caseState: caseRow.state,
      previousCaseState: proposal.previous_case_state,
      caseVersion: proposal.case_version,
      confirmationPhrase: confirmationPhrase(proposal.action, target.payment_reference, proposal.amount_minor, proposal.currency),
      checks,
      limits: proposal.action === 'reissue' ? limitUsage(db, proposal.organisation_id, proposal.currency as PayoutCurrency, clock()) : null,
      attempts: [attemptView(db, ev.original, 'original', null), ...ev.recoveries.map((r, i) => attemptView(db, r, 'recovery', i + 1))],
      submission: submission ? submissionView(db, submission) : null,
      cancellation: cancellation ? cancellationView(db, cancellation) : null,
      permissions: {
        canApprove: pending && canDecideRole && !isProposer && failing.length === 0,
        canReject: pending && canDecideRole && !isProposer,
        canWithdraw: pending && (isProposer || ctx.actor.user.role === 'admin'),
        reason,
      },
      history: history(proposal, submission, cancellation),
      sandboxNotice: targetText(db, SANDBOX_NOTICE),
    };
  }

  function caseActions(ctx: RequestContext, caseId: string): PaymentActionsResponse {
    const caseRow = ownCase(ctx, caseId);
    const open = db.prepare("SELECT * FROM payout_proposals WHERE case_id = ? AND status = 'pending_approval'").get(caseId) as ProposalRow | undefined;
    if (open) expireIfDue(open);
    const ev = evaluate(caseId);
    const env = deps.environment();
    const role = ctx.actor.user.role;
    const original = ev.original.item;
    const attemptIds = [original.id, ...ev.recoveries.map((r) => r.item.id)];
    const placeholders = attemptIds.map(() => '?').join(',');
    const proposals = (db.prepare('SELECT * FROM payout_proposals WHERE case_id = ? ORDER BY proposed_at DESC, rowid DESC').all(caseId) as ProposalRow[]).map((p) =>
      proposalSummary(db, p),
    );
    const subs = db
      .prepare(`SELECT s.* FROM payout_submissions s JOIN payout_submission_items si ON si.submission_id = s.id WHERE si.original_item_id IN (${placeholders}) ORDER BY s.approved_at DESC`)
      .all(...attemptIds) as SubmissionRow[];
    const cans = db.prepare(`SELECT * FROM payout_cancellations WHERE target_item_id IN (${placeholders}) ORDER BY approved_at DESC`).all(...attemptIds) as CancellationRow[];
    const discrepancies = db.prepare('SELECT * FROM provider_discrepancies WHERE original_item_id = ? ORDER BY recorded_at DESC').all(original.id) as DiscrepancyRow[];
    const reconciliations = db
      .prepare(
        `SELECT * FROM payout_reconciliations WHERE submission_id IN (${subs.map(() => '?').join(',') || "''"}) OR cancellation_id IN (${cans.map(() => '?').join(',') || "''"}) ORDER BY recorded_at DESC`,
      )
      .all(...subs.map((s) => s.id), ...cans.map((c) => c.id)) as Parameters<typeof reconciliationView>[1][];
    const currency = original.currency as PayoutCurrency;
    const sandboxReady = env.providerMode === 'sandbox' && env.configured;
    return {
      sandboxNotice: targetText(db, SANDBOX_NOTICE),
      providerMode: env.providerMode,
      enabled: sandboxReady && env.payoutsEnabled,
      blocks: ev.blocks,
      case: { id: caseRow.id, reference: caseRow.reference, state: caseRow.state, version: caseRow.version },
      original: attemptView(db, ev.original, 'original', null),
      recoveries: ev.recoveries.map((r, i) => attemptView(db, r, 'recovery', i + 1)),
      providerFingerprint: ev.fingerprint,
      reissue: {
        available: ev.reissue.available && PROPOSE_ROLES.includes(role),
        reasons: ev.reissue.reasons,
        statusCheckRequired: ev.reissue.statusCheckRequired,
        reasonCodes: REISSUE_REASON_CODES,
        attemptNumber: ev.reissue.attemptNumber,
        amount: { currency: original.currency as CurrencyCode, minor: original.amount_minor },
        receiverMasked: original.receiver_masked,
        senderItemId: ev.reissue.senderItemId,
        receiverAllowlisted: !!ev.reissue.allowlistEntry,
      },
      cancel: {
        available: ev.cancel.available && PROPOSE_ROLES.includes(role),
        reasons: ev.cancel.reasons,
        statusCheckRequired: ev.cancel.statusCheckRequired,
        reasonCodes: CANCEL_REASON_CODES,
        target: ev.cancel.target ? { id: ev.cancel.target.item.id, reference: ev.cancel.target.item.payment_reference } : null,
      },
      openProposal: proposals.find((p) => p.status === 'pending_approval') ?? null,
      proposals,
      submissions: subs.map((s) => submissionView(db, s)),
      cancellations: cans.map((c) => cancellationView(db, c)),
      discrepancies: discrepancies.map((d) => discrepancyView(db, d)),
      reconciliations: reconciliations.map((r) => reconciliationView(db, r)),
      limits: (['GBP', 'USD', 'EUR'] as const).includes(currency) ? limitUsage(db, caseRow.organisation_id, currency, clock()) : null,
      permissions: {
        canPropose: PROPOSE_ROLES.includes(role),
        canCheckStatus: CHECK_ROLES.includes(role) && sandboxReady,
        canReconcile: role === 'admin',
      },
    };
  }

  return {
    caseActions: async (ctx: RequestContext, caseId: string) => caseActions(ctx, caseId),
    getProposal: async (ctx: RequestContext, id: string) => proposalDetail(ctx, id),

    async listProposals(ctx: RequestContext, status?: string): Promise<ProposalListResponse> {
      const pending = db.prepare("SELECT * FROM payout_proposals WHERE organisation_id = ? AND status = 'pending_approval'").all(ctx.actor.organisationId) as ProposalRow[];
      for (const p of pending) expireIfDue(p);
      const rows = db
        .prepare(`SELECT * FROM payout_proposals WHERE organisation_id = ? ${status ? 'AND status = ?' : ''} ORDER BY proposed_at DESC, rowid DESC LIMIT 200`)
        .all(...(status ? [ctx.actor.organisationId, status] : [ctx.actor.organisationId])) as ProposalRow[];
      const counts = Object.fromEntries(PROPOSAL_STATUSES.map((s) => [s, 0])) as ProposalListResponse['counts'];
      for (const row of db.prepare('SELECT status, count(*) AS n FROM payout_proposals WHERE organisation_id = ? GROUP BY status').all(ctx.actor.organisationId) as {
        status: keyof ProposalListResponse['counts'];
        n: number;
      }[]) {
        counts[row.status] = row.n;
      }
      return { proposals: rows.map((r) => proposalSummary(db, r)), counts };
    },

    async checkStatus(ctx: RequestContext, caseId: string, itemId: string): Promise<StatusCheckResponse> {
      assertRole(db, ctx, CHECK_ROLES, 'paypal.status_checked', 'payment_item', itemId);
      const caseRow = ownCase(ctx, caseId);
      const env = deps.environment();
      if (env.providerMode !== 'sandbox' || !env.configured || !deps.client) {
        auditRejection(db, ctx, 'paypal.status_checked', 'payment_item', itemId, 'PayPal Sandbox is not available in this mode.');
        throw new AppError('conflict', 'Status checks need PayPal Sandbox mode with credentials configured.');
      }
      const ev = evaluate(caseRow.id);
      const attempt = [ev.original, ...ev.recoveries].find((a) => a.item.id === itemId);
      if (!attempt) throw new AppError('not_found', 'That payment is not part of this case.');
      if (!providerItemIdFor(db, itemId)) throw new AppError('conflict', 'This payment has no PayPal Sandbox item to check. Simulated records cannot be checked with PayPal.');
      const recent = db
        .prepare("SELECT checked_at FROM provider_status_checks WHERE payment_item_id = ? AND source = 'manual' ORDER BY checked_at DESC LIMIT 1")
        .get(itemId) as { checked_at: string } | undefined;
      if (recent && Date.parse(recent.checked_at) > clock().getTime() - MANUAL_CHECK_INTERVAL_MS) {
        throw new AppError('too_many_requests', 'This payment was checked a few seconds ago. Wait a moment before checking again.');
      }
      const check = await fetchItemStatus(deps, { paymentItemId: itemId, source: 'manual', requestedByUserId: ctx.actor.user.id });
      auditPayout(db, {
        organisationId: ctx.actor.organisationId,
        actor: auditActor(ctx),
        action: 'paypal.status_checked',
        entityType: 'payment_item',
        entityId: itemId,
        outcome: 'succeeded',
        requestId: ctx.requestId,
        newState: { outcome: check.outcome, itemStatus: check.item_status },
      });
      return { check: statusCheckView(db, check), actions: caseActions(ctx, caseId) };
    },

    async createProposal(ctx: RequestContext, caseId: string, input: CreateProposalRequest): Promise<ProposalDetail> {
      const action = 'payout.proposal_created';
      assertRole(db, ctx, PROPOSE_ROLES, action, 'payment_case', caseId);
      const caseRow = ownCase(ctx, caseId);
      if (!PROPOSAL_REASON_INFO[input.reasonCode].actions.includes(input.action)) {
        auditRejection(db, ctx, action, 'payment_case', caseId, 'The reason does not apply to this action.');
        throw new AppError('validation_failed', 'Choose a reason that applies to this action.');
      }
      if (findContactDetails(input.justification).length > 0) {
        auditRejection(db, ctx, action, 'payment_case', caseId, 'Justification contained contact details and was not saved.');
        throw new AppError('validation_failed', 'The justification must not contain email addresses or phone numbers. Refer to recipients by their programme reference.');
      }

      const before = evaluate(caseRow.id);
      const option = input.action === 'reissue' ? before.reissue : before.cancel;
      if (before.blocks.length === 0 && option.reasons.length === 0 && option.statusCheckRequired && option.target) {
        await fetchItemStatus(deps, { paymentItemId: option.target.item.id, source: 'precheck', requestedByUserId: ctx.actor.user.id });
      }

      const proposalId = guarded(ctx, action, 'payment_case', caseId, () => {
        const current = loadCase(db, caseId)!;
        if (current.version !== input.caseVersion) {
          throw new AppError('conflict', 'This case changed since you opened it. Review the latest details before proposing.', { reason: 'stale_version', currentVersion: current.version });
        }
        const ev = evaluateCase(db, current, deps.environment(), clock());
        if (ev.blocks.length) throw new AppError('conflict', ev.blocks[0]!.message, { reason: 'blocked', blocks: ev.blocks });
        if (ev.fingerprint !== input.providerFingerprint) {
          throw new AppError('conflict', 'A provider status changed since you opened this case. Review the latest status before proposing.', { reason: 'provider_status_changed' });
        }
        const opt = input.action === 'reissue' ? ev.reissue : ev.cancel;
        if (opt.reasons.length) throw new AppError('conflict', opt.reasons[0]!, { reason: 'not_eligible', reasons: opt.reasons });
        if (opt.statusCheckRequired || !opt.target) {
          throw new AppError('conflict', 'A fresh PayPal Sandbox status could not be confirmed. Check the status and try again.', { reason: 'status_check_required' });
        }
        const now = clock();
        const at = now.toISOString();
        const original = ev.original.item;
        const id = `prop_${randomUUID()}`;
        const statusCheckId = opt.target.provider?.mode === 'sandbox' ? (opt.target.latestCheck?.id ?? null) : null;
        db.prepare(
          `INSERT INTO payout_proposals (id, organisation_id, case_id, original_item_id, action, target_item_id, attempt_number, amount_minor, currency,
             receiver_masked, allowlist_entry_id, reason_code, justification, attestation, provider_fingerprint, status_check_id, previous_case_state,
             case_version, proposed_by_user_id, proposed_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          current.organisation_id,
          current.id,
          original.id,
          input.action,
          opt.target.item.id,
          input.action === 'reissue' ? ev.reissue.attemptNumber : null,
          original.amount_minor,
          original.currency,
          original.receiver_masked,
          input.action === 'reissue' ? (ev.reissue.allowlistEntry?.id ?? null) : null,
          input.reasonCode,
          input.justification.trim(),
          ev.fingerprint,
          statusCheckId,
          current.state,
          current.version,
          ctx.actor.user.id,
          at,
          addMs(now, PAYOUT_LIMITS.proposalExpiryHours * HOUR),
        );
        auditPayout(db, {
          organisationId: current.organisation_id,
          actor: auditActor(ctx),
          action,
          entityType: 'payout_proposal',
          entityId: id,
          outcome: 'succeeded',
          requestId: ctx.requestId,
          newState: { action: input.action, caseId: current.id, targetItemId: opt.target.item.id, amountMinor: original.amount_minor, currency: original.currency, reasonCode: input.reasonCode },
          reason: input.justification.trim().slice(0, 500),
        });
        transitionCase(db, {
          caseRow: current,
          to: 'awaiting_approval',
          at,
          actor: auditActor(ctx),
          requestId: ctx.requestId,
          source: 'operator',
          summary:
            input.action === 'reissue'
              ? `${ctx.actor.user.displayName} proposed reissuing ${opt.target.item.payment_reference} to the original receiver in PayPal Sandbox. Awaiting a different approver.`
              : `${ctx.actor.user.displayName} proposed cancelling unclaimed Sandbox payout ${opt.target.item.payment_reference}. Awaiting a different approver.`,
          auditAction: 'payout.case_awaiting_approval',
        });
        return id;
      });
      return proposalDetail(ctx, proposalId);
    },

    async approve(ctx: RequestContext, id: string, input: ApproveProposalRequest): Promise<ProposalDetail> {
      const action = 'payout.proposal_approved';
      assertRole(db, ctx, DECIDE_ROLES, action, 'payout_proposal', id);
      let proposal = ownProposal(ctx, id);
      if (proposal.proposed_by_user_id === ctx.actor.user.id) {
        auditRejection(db, ctx, action, 'payout_proposal', id, 'The proposer cannot approve their own proposal.', { reason: 'self_decision_forbidden' });
        throw new AppError('forbidden', 'You proposed this action. A different approver must decide it.', { reason: 'self_decision_forbidden' });
      }
      proposal = expireIfDue(proposal);
      if (proposal.status === 'pending_approval') {
        const pre = evaluate(proposal.case_id, proposal.id);
        if (proposal.action === 'reissue' && pre.blocks.length === 0 && pre.reissue.statusCheckRequired) {
          await fetchItemStatus(deps, { paymentItemId: proposal.target_item_id, source: 'precheck', requestedByUserId: ctx.actor.user.id });
        }
      }

      const created = guarded(ctx, action, 'payout_proposal', id, (): { submissionId?: string; cancellationId?: string } => {
        const p = loadProposal(db, id)!;
        if (p.status !== 'pending_approval') {
          throw new AppError('conflict', `This proposal is no longer awaiting approval (${p.status}). Nothing was sent.`, { reason: 'not_pending', status: p.status });
        }
        if (p.version !== input.proposalVersion) throw new AppError('conflict', 'This proposal changed since you opened it. Review it again.', { reason: 'stale_version' });
        const now = clock();
        const at = now.toISOString();
        if (at >= p.expires_at) throw new AppError('conflict', 'This proposal has expired. Nothing was sent.', { reason: 'expired' });
        const target = loadItem(db, p.target_item_id)!;
        const expected = confirmationPhrase(p.action, target.payment_reference, p.amount_minor, p.currency);
        if (normaliseConfirmation(input.confirmation) !== expected) {
          throw new AppError('validation_failed', `Type the confirmation exactly as shown: ${expected}`, { reason: 'confirmation_mismatch' });
        }
        const caseRow = loadCase(db, p.case_id)!;
        if (caseRow.state !== 'awaiting_approval') throw new AppError('conflict', 'The case is no longer awaiting approval.', { reason: 'case_state' });
        const ev = evaluateCase(db, caseRow, deps.environment(), now, { ignoreProposalId: p.id });
        if (ev.blocks.length) throw new AppError('conflict', `${ev.blocks[0]!.message} Nothing was sent.`, { reason: 'blocked', blocks: ev.blocks });
        if (ev.fingerprint !== p.provider_fingerprint) {
          throw new AppError('conflict', 'A provider status changed after this proposal was made. Nothing was sent.', { reason: 'provider_status_changed' });
        }
        const opt = p.action === 'reissue' ? ev.reissue : ev.cancel;
        if (opt.reasons.length) throw new AppError('conflict', `${opt.reasons[0]} Nothing was sent.`, { reason: 'not_eligible', reasons: opt.reasons });
        if (opt.statusCheckRequired) throw new AppError('conflict', 'A fresh PayPal Sandbox status could not be confirmed. Nothing was sent; try again.', { reason: 'status_check_required' });
        if (opt.target?.item.id !== p.target_item_id) throw new AppError('conflict', 'The payment this proposal targets is no longer the latest attempt. Nothing was sent.', { reason: 'target_changed' });

        if (p.action === 'reissue') {
          if (!ev.reissue.allowlistEntry || ev.reissue.allowlistEntry.id !== p.allowlist_entry_id) {
            throw new AppError('conflict', 'The receiver is no longer an active entry on the reserved receiver allowlist. Nothing was sent.', { reason: 'allowlist' });
          }
          if (ev.reissue.attemptNumber !== p.attempt_number || !ev.reissue.senderItemId) {
            throw new AppError('conflict', 'The recovery attempt number changed. Nothing was sent.', { reason: 'attempt_changed' });
          }
          const usage = limitUsage(db, p.organisation_id, p.currency as PayoutCurrency, now);
          if (usage.payoutsToday + 1 > usage.maxPayoutsPerDay) {
            throw new AppError('conflict', `The daily limit of ${usage.maxPayoutsPerDay} Sandbox payouts has been reached. Nothing was sent.`, { reason: 'daily_count_limit' });
          }
          if (usage.valueTodayMinor + p.amount_minor > usage.maxValuePerCurrencyPerDayMinor) {
            throw new AppError('conflict', `This payout would exceed today's ${p.currency} value limit. Nothing was sent.`, { reason: 'daily_value_limit' });
          }
        }

        db.prepare(
          "UPDATE payout_proposals SET status = 'approved', decided_by_user_id = ?, decided_at = ?, confirmation_sha256 = ?, version = version + 1 WHERE id = ?",
        ).run(ctx.actor.user.id, at, sha256Hex(normaliseConfirmation(input.confirmation)), p.id);
        auditPayout(db, {
          organisationId: p.organisation_id,
          actor: auditActor(ctx),
          action,
          entityType: 'payout_proposal',
          entityId: p.id,
          outcome: 'succeeded',
          requestId: ctx.requestId,
          previousState: { status: 'pending_approval', version: p.version },
          newState: { status: 'approved', version: p.version + 1, proposedByUserId: p.proposed_by_user_id },
          reason: 'Approved after typed confirmation.',
        });
        const proposerName = userName(p.proposed_by_user_id);

        if (p.action === 'reissue') {
          const original = ev.original.item;
          const submissionId = `sub_${randomUUID()}`;
          const senderBatchId = `RRS-${randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}`;
          const paypalRequestId = randomUUID();
          const senderItemId = ev.reissue.senderItemId!;
          const built = buildPayoutRequest({ senderBatchId, senderItemId, receiver: original.receiver_value, amountMinor: p.amount_minor, currency: p.currency as PayoutCurrency });
          db.prepare(
            `INSERT INTO payout_submissions (id, organisation_id, case_id, proposal_id, sender_batch_id, paypal_request_id, request_sha256, approved_at, replay_deadline_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(submissionId, p.organisation_id, p.case_id, p.id, senderBatchId, paypalRequestId, built.sha256, at, addMs(now, PAYOUT_LIMITS.replayDeadlineDays * DAY));
          db.prepare(
            'INSERT INTO payout_submission_items (id, submission_id, original_item_id, sender_item_id, amount_minor, currency) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(`sbi_${randomUUID()}`, submissionId, original.id, senderItemId, p.amount_minor, p.currency);
          auditPayout(db, {
            organisationId: p.organisation_id,
            actor: auditActor(ctx),
            action: 'payout.submission_prepared',
            entityType: 'payout_submission',
            entityId: submissionId,
            outcome: 'succeeded',
            requestId: ctx.requestId,
            newState: { senderBatchId, senderItemId, amountMinor: p.amount_minor, currency: p.currency },
            reason: 'Idempotency keys generated once at approval. Every send of this submission reuses them.',
          });
          transitionCase(db, {
            caseRow,
            to: 'recovery_submitted',
            at,
            actor: auditActor(ctx),
            requestId: ctx.requestId,
            eventType: 'recovery_submitted',
            source: 'operator',
            summary: `${ctx.actor.user.displayName} approved the reissue proposed by ${proposerName} and submitted ${senderItemId} to PayPal Sandbox. ${SANDBOX_SUFFIX}`,
            auditAction: 'payout.case_recovery_submitted',
          });
          return { submissionId };
        }

        const providerItemId = providerItemIdFor(db, p.target_item_id);
        if (!providerItemId) throw new AppError('conflict', 'The Sandbox payout has no PayPal item ID. Nothing was sent.', { reason: 'no_provider_item' });
        const cancellationId = `can_${randomUUID()}`;
        db.prepare(
          `INSERT INTO payout_cancellations (id, organisation_id, case_id, proposal_id, target_item_id, provider_item_id, approved_at, send_deadline_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(cancellationId, p.organisation_id, p.case_id, p.id, p.target_item_id, providerItemId, at, addMs(now, PAYOUT_LIMITS.cancellationWindowHours * HOUR));
        auditPayout(db, {
          organisationId: p.organisation_id,
          actor: auditActor(ctx),
          action: 'payout.cancellation_prepared',
          entityType: 'payout_cancellation',
          entityId: cancellationId,
          outcome: 'succeeded',
          requestId: ctx.requestId,
          newState: { targetItemId: p.target_item_id },
          reason: 'The item status is fetched from PayPal Sandbox before any cancellation is sent.',
        });
        transitionCase(db, {
          caseRow,
          to: 'recovery_submitted',
          at,
          actor: auditActor(ctx),
          requestId: ctx.requestId,
          source: 'operator',
          summary: `${ctx.actor.user.displayName} approved cancelling ${target.payment_reference}, proposed by ${proposerName}. The status is checked before the cancellation is sent.`,
          auditAction: 'payout.case_cancellation_approved',
        });
        return { cancellationId };
      });

      if (created.submissionId) await submissions.sendAfterApproval(created.submissionId);
      if (created.cancellationId) await cancellations.runAfterApproval(created.cancellationId);
      return proposalDetail(ctx, id);
    },

    async reject(ctx: RequestContext, id: string, input: DecideProposalRequest): Promise<ProposalDetail> {
      const action = 'payout.proposal_rejected';
      assertRole(db, ctx, DECIDE_ROLES, action, 'payout_proposal', id);
      const proposal = ownProposal(ctx, id);
      if (proposal.proposed_by_user_id === ctx.actor.user.id) {
        auditRejection(db, ctx, action, 'payout_proposal', id, 'The proposer cannot decide their own proposal.', { reason: 'self_decision_forbidden' });
        throw new AppError('forbidden', 'You proposed this action. A different approver must decide it; you can withdraw it instead.', { reason: 'self_decision_forbidden' });
      }
      expireIfDue(proposal);
      guarded(ctx, action, 'payout_proposal', id, () => decide(ctx, id, input, 'rejected'));
      return proposalDetail(ctx, id);
    },

    async withdraw(ctx: RequestContext, id: string, input: DecideProposalRequest): Promise<ProposalDetail> {
      const action = 'payout.proposal_withdrawn';
      const proposal = ownProposal(ctx, id);
      if (proposal.proposed_by_user_id !== ctx.actor.user.id && ctx.actor.user.role !== 'admin') {
        auditRejection(db, ctx, action, 'payout_proposal', id, 'Only the proposer or an administrator can withdraw a proposal.');
        throw new AppError('forbidden', 'Only the proposer or an administrator can withdraw this proposal.');
      }
      expireIfDue(proposal);
      guarded(ctx, action, 'payout_proposal', id, () => decide(ctx, id, input, 'withdrawn'));
      return proposalDetail(ctx, id);
    },

    async retrySubmission(ctx: RequestContext, submissionId: string) {
      const action = 'payout.submission_retry_requested';
      assertRole(db, ctx, DECIDE_ROLES, action, 'payout_submission', submissionId);
      const sub = loadSubmission(db, submissionId);
      if (!sub || sub.organisation_id !== ctx.actor.organisationId) throw new AppError('not_found', 'Submission not found.');
      if (sub.state !== 'not_processed' && sub.state !== 'outcome_unknown') {
        auditRejection(db, ctx, action, 'payout_submission', submissionId, `Submission is ${sub.state}.`);
        throw new AppError('conflict', 'Only a submission that was not processed or has an unknown outcome can be retried.');
      }
      auditPayout(db, {
        organisationId: ctx.actor.organisationId,
        actor: auditActor(ctx),
        action,
        entityType: 'payout_submission',
        entityId: submissionId,
        outcome: 'succeeded',
        requestId: ctx.requestId,
        reason: 'Retry with the same approved keys and request body.',
      });
      await submissions.attemptOnce(submissionId, `retry requested by ${ctx.actor.user.displayName}`);
      return caseActions(ctx, sub.case_id);
    },

    async reconcileSubmission(ctx: RequestContext, submissionId: string, input: ReconcileRequest) {
      const action = 'payout.submission_reconciled';
      assertRole(db, ctx, ADMIN, action, 'payout_submission', submissionId);
      const sub = loadSubmission(db, submissionId);
      if (!sub || sub.organisation_id !== ctx.actor.organisationId) throw new AppError('not_found', 'Submission not found.');
      if (input.action === 'link_batch') {
        if (!input.providerBatchId || !PAYPAL_ID.test(input.providerBatchId)) throw new AppError('validation_failed', 'Enter a PayPal payout batch ID.');
        if (!['needs_manual_reconciliation', 'outcome_unknown', 'not_processed'].includes(sub.state)) {
          auditRejection(db, ctx, action, 'payout_submission', submissionId, `Submission is ${sub.state}.`);
          throw new AppError('conflict', 'This submission does not need reconciliation.');
        }
        const linked = await submissions.resolveFromBatch(submissionId, input.providerBatchId, auditActor(ctx));
        if (!linked) {
          auditRejection(db, ctx, action, 'payout_submission', submissionId, 'The batch did not carry this submission’s sender batch ID or could not be read.');
          throw new AppError('conflict', 'That PayPal Sandbox batch could not be read or does not carry this submission’s sender batch ID. Nothing was linked.');
        }
        db.prepare(
          "INSERT INTO payout_reconciliations (id, organisation_id, submission_id, action, provider_batch_id, note, user_id, recorded_at) VALUES (?, ?, ?, 'link_batch', ?, ?, ?, ?)",
        ).run(`rec_${randomUUID()}`, sub.organisation_id, sub.id, input.providerBatchId, input.note?.trim() || null, ctx.actor.user.id, clock().toISOString());
        return caseActions(ctx, sub.case_id);
      }
      if (input.action !== 'record_not_created') throw new AppError('validation_failed', 'Unsupported reconciliation action for a submission.');
      const note = input.note?.trim() ?? '';
      if (note.length < 10) throw new AppError('validation_failed', 'Explain how you confirmed that PayPal Sandbox never created this payout (at least 10 characters).');
      guarded(ctx, action, 'payout_submission', submissionId, () => {
        const current = loadSubmission(db, submissionId)!;
        const at = clock().toISOString();
        if (current.state !== 'needs_manual_reconciliation') throw new AppError('conflict', 'Only a submission awaiting manual reconciliation can be recorded as not created.');
        if (at < addMs(current.approved_at, PAYOUT_LIMITS.recordNotCreatedAfterDays * DAY)) {
          throw new AppError('conflict', `A submission can only be recorded as not created ${PAYOUT_LIMITS.recordNotCreatedAfterDays} days after approval, once PayPal's duplicate protection has passed.`);
        }
        db.prepare(
          "INSERT INTO payout_reconciliations (id, organisation_id, submission_id, action, note, user_id, recorded_at) VALUES (?, ?, ?, 'record_not_created', ?, ?, ?)",
        ).run(`rec_${randomUUID()}`, current.organisation_id, current.id, note, ctx.actor.user.id, at);
        db.prepare("UPDATE payout_submissions SET state = 'reconciled_not_created', completed_at = ?, version = version + 1 WHERE id = ?").run(at, current.id);
        auditPayout(db, {
          organisationId: current.organisation_id,
          actor: auditActor(ctx),
          action,
          entityType: 'payout_submission',
          entityId: current.id,
          outcome: 'succeeded',
          requestId: ctx.requestId,
          previousState: { state: current.state },
          newState: { state: 'reconciled_not_created' },
          reason: note.slice(0, 500),
        });
        const caseRow = loadCase(db, current.case_id)!;
        if (caseRow.state === 'recovery_submitted') {
          transitionCase(db, {
            caseRow,
            to: 'investigating',
            at,
            actor: auditActor(ctx),
            requestId: ctx.requestId,
            source: 'operator',
            summary: `${ctx.actor.user.displayName} recorded that PayPal Sandbox never created recovery submission ${current.sender_batch_id}.`,
            auditAction: 'payout.case_reopened_for_investigation',
          });
        }
      });
      return caseActions(ctx, sub.case_id);
    },

    async recheckCancellation(ctx: RequestContext, cancellationId: string) {
      const action = 'payout.cancellation_reconciled';
      assertRole(db, ctx, ADMIN, action, 'payout_cancellation', cancellationId);
      const can = loadCancellation(db, cancellationId);
      if (!can || can.organisation_id !== ctx.actor.organisationId) throw new AppError('not_found', 'Cancellation not found.');
      if (can.state !== 'needs_manual_reconciliation') {
        auditRejection(db, ctx, action, 'payout_cancellation', cancellationId, `Cancellation is ${can.state}.`);
        throw new AppError('conflict', 'This cancellation does not need reconciliation.');
      }
      if (!deps.client) throw new AppError('service_unavailable', 'PayPal Sandbox is not configured on this server.');
      await cancellations.recheck(cancellationId, ctx.actor.user.id);
      return caseActions(ctx, can.case_id);
    },

    async resolveDiscrepancy(ctx: RequestContext, discrepancyId: string, note: string) {
      const action = 'paypal.discrepancy_resolved';
      assertRole(db, ctx, ADMIN, action, 'provider_discrepancy', discrepancyId);
      const row = db.prepare('SELECT * FROM provider_discrepancies WHERE id = ? AND organisation_id = ?').get(discrepancyId, ctx.actor.organisationId) as DiscrepancyRow | undefined;
      if (!row) throw new AppError('not_found', 'Discrepancy not found.');
      if (findContactDetails(note).length > 0) throw new AppError('validation_failed', 'The note must not contain email addresses or phone numbers.');
      guarded(ctx, action, 'provider_discrepancy', discrepancyId, () => {
        if (db.prepare('SELECT 1 FROM provider_discrepancy_resolutions WHERE discrepancy_id = ?').get(discrepancyId)) {
          throw new AppError('conflict', 'This discrepancy has already been resolved.');
        }
        db.prepare('INSERT INTO provider_discrepancy_resolutions (discrepancy_id, resolved_by_user_id, note, resolved_at) VALUES (?, ?, ?, ?)').run(
          discrepancyId,
          ctx.actor.user.id,
          note.trim(),
          clock().toISOString(),
        );
        auditPayout(db, {
          organisationId: ctx.actor.organisationId,
          actor: auditActor(ctx),
          action,
          entityType: 'provider_discrepancy',
          entityId: discrepancyId,
          outcome: 'succeeded',
          requestId: ctx.requestId,
          newState: { resolved: true, code: row.code },
          reason: note.trim().slice(0, 500),
        });
      });
      const caseRow = db.prepare('SELECT id FROM payment_cases WHERE payment_item_id = ? ORDER BY opened_at DESC LIMIT 1').get(row.original_item_id) as { id: string };
      return caseActions(ctx, caseRow.id);
    },

    /** Expires proposals left undecided past their deadline. Called by the poller. */
    expireDue(): number {
      const due = db.prepare("SELECT * FROM payout_proposals WHERE status = 'pending_approval' AND expires_at <= ?").all(clock().toISOString()) as ProposalRow[];
      for (const p of due) expireIfDue(p);
      return due.length;
    },
  };

  function userName(userId: string): string {
    return (db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as { display_name: string } | undefined)?.display_name ?? 'another user';
  }

  /** Rejects or withdraws a pending proposal and returns the case to its earlier state. Call inside a transaction. */
  function decide(ctx: RequestContext, id: string, input: DecideProposalRequest, status: 'rejected' | 'withdrawn') {
    const p = loadProposal(db, id)!;
    if (p.status !== 'pending_approval') throw new AppError('conflict', `This proposal is no longer awaiting approval (${p.status}).`, { reason: 'not_pending' });
    if (p.version !== input.proposalVersion) throw new AppError('conflict', 'This proposal changed since you opened it. Review it again.', { reason: 'stale_version' });
    const reason = input.reason.trim();
    if (reason.length < 5) throw new AppError('validation_failed', 'Give a short reason (at least 5 characters).');
    if (findContactDetails(reason).length > 0) throw new AppError('validation_failed', 'The reason must not contain email addresses or phone numbers.');
    const at = clock().toISOString();
    db.prepare('UPDATE payout_proposals SET status = ?, decided_by_user_id = ?, decided_at = ?, decision_reason = ?, version = version + 1 WHERE id = ?').run(
      status,
      ctx.actor.user.id,
      at,
      reason.slice(0, 500),
      id,
    );
    auditPayout(db, {
      organisationId: p.organisation_id,
      actor: auditActor(ctx),
      action: status === 'rejected' ? 'payout.proposal_rejected' : 'payout.proposal_withdrawn',
      entityType: 'payout_proposal',
      entityId: id,
      outcome: 'succeeded',
      requestId: ctx.requestId,
      previousState: { status: 'pending_approval', version: p.version },
      newState: { status, version: p.version + 1 },
      reason: reason.slice(0, 500),
    });
    restoreCaseAfterProposal(
      db,
      loadProposal(db, id)!,
      at,
      auditActor(ctx),
      ctx.requestId,
      `${ctx.actor.user.displayName} ${status === 'rejected' ? 'rejected' : 'withdrew'} the proposal. Nothing was sent.`,
    );
  }
}

export type PayoutService = ReturnType<typeof createPayoutService>;
