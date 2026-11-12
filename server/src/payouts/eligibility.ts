import type { PaymentActionBlock } from '@shared/api/contracts';
import {
  isPayoutCurrency,
  PAYOUT_LIMITS,
  PROPOSAL_REASON_CODES,
  PROPOSAL_REASON_INFO,
  recoverySenderItemId,
  REISSUE_ELIGIBLE_STATUSES,
  SENDER_ITEM_ID_MAX_LENGTH,
  type ProposalAction,
  type ProposalReasonCode,
} from '@shared/domain/payouts';
import type { ProviderMode } from '@shared/domain/types';
import { sha256Hex, type Db } from '../db/connection';
import type { CaseRow, ProviderRow } from '../repositories/sqlite/readModel';
import { findActiveEntry, type AllowlistEntry } from './allowlist';
import {
  ACTIVE_CANCELLATION_STATES,
  ACTIVE_SUBMISSION_STATES,
  hasUnresolvedCriticalDiscrepancy,
  latestCheck,
  loadItem,
  loadProvider,
  MINUTE,
  recoveriesOf,
  type FullItemRow,
  type ProposalRow,
  type StatusCheckRow,
} from './records';

export interface PayoutEnvironment {
  providerMode: ProviderMode;
  configured: boolean;
  payoutsEnabled: boolean;
}

export interface Attempt {
  item: FullItemRow;
  provider: (ProviderRow & { updated_at: string }) | undefined;
  latestCheck: StatusCheckRow | undefined;
  /** A successful check no older than the freshness window and not older than the stored provider record. */
  checkFresh: boolean;
}

export interface Evaluation {
  caseRow: CaseRow;
  original: Attempt;
  recoveries: Attempt[];
  fingerprint: string;
  blocks: PaymentActionBlock[];
  openProposal: ProposalRow | undefined;
  reissue: {
    available: boolean;
    reasons: string[];
    statusCheckRequired: boolean;
    /** The undelivered attempt the reissue replaces: the original or the latest recovery. */
    target: Attempt;
    attemptNumber: number | null;
    senderItemId: string | null;
    allowlistEntry: AllowlistEntry | null;
  };
  cancel: { available: boolean; reasons: string[]; statusCheckRequired: boolean; target: Attempt | null };
}

const reasonCodesFor = (action: ProposalAction): ProposalReasonCode[] => PROPOSAL_REASON_CODES.filter((code) => PROPOSAL_REASON_INFO[code].actions.includes(action));
export const REISSUE_REASON_CODES = reasonCodesFor('reissue');
export const CANCEL_REASON_CODES = reasonCodesFor('cancel_unclaimed');

export function isFresh(check: StatusCheckRow | undefined, provider: { updated_at: string } | undefined, now: Date): boolean {
  if (!check || check.outcome !== 'ok') return false;
  if (Date.parse(check.checked_at) < now.getTime() - PAYOUT_LIMITS.freshStatusCheckMinutes * MINUTE) return false;
  return !provider || check.checked_at >= provider.updated_at;
}

function attemptFor(db: Db, item: FullItemRow, now: Date): Attempt {
  const provider = loadProvider(db, item.id);
  const check = latestCheck(db, item.id);
  return { item, provider, latestCheck: check, checkFresh: isFresh(check, provider, now) };
}

/** SHA-256 of every attempt's provider status. Last-checked times are excluded: re-reading the same status does not change it. */
export function providerFingerprint(attempts: Attempt[]): string {
  return sha256Hex(
    JSON.stringify(attempts.map((a) => [a.item.id, a.provider?.mode ?? null, a.provider?.status ?? null, a.provider?.status_updated_at ?? null])),
  );
}

/**
 * Works out, on the server, which payment actions are allowed for a case right now and why not. Proposal creation
 * and approval both call this and refuse unless it allows the action.
 */
export function evaluateCase(db: Db, caseRow: CaseRow, env: PayoutEnvironment, now: Date, options: { ignoreProposalId?: string } = {}): Evaluation {
  const originalItem = loadItem(db, caseRow.payment_item_id)!;
  const original = attemptFor(db, originalItem, now);
  const recoveries = recoveriesOf(db, originalItem.id).map((item) => attemptFor(db, item, now));
  const attempts = [original, ...recoveries];
  const fingerprint = providerFingerprint(attempts);

  const blocks: PaymentActionBlock[] = [];
  if (env.providerMode !== 'sandbox') blocks.push({ code: 'simulation_mode', message: 'Payment actions are disabled in simulation mode. Nothing can be sent to PayPal.' });
  else if (!env.configured) blocks.push({ code: 'not_configured', message: 'PayPal Sandbox credentials are not configured on this server.' });
  else if (!env.payoutsEnabled) blocks.push({ code: 'payouts_disabled', message: 'Payment actions are switched off on this server (PAYPAL_PAYOUTS_ENABLED is not true).' });
  if (caseRow.state === 'resolved' || caseRow.state === 'closed') blocks.push({ code: 'case_not_active', message: 'This case is no longer active.' });

  const submissions = db
    .prepare(
      `SELECT s.state FROM payout_submissions s JOIN payout_submission_items si ON si.submission_id = s.id WHERE si.original_item_id IN (${attempts.map(() => '?').join(',')})`,
    )
    .all(...attempts.map((a) => a.item.id)) as { state: string }[];
  const cancellations = db
    .prepare(`SELECT state FROM payout_cancellations WHERE target_item_id IN (${attempts.map(() => '?').join(',')})`)
    .all(...attempts.map((a) => a.item.id)) as { state: string }[];
  if (submissions.some((s) => s.state === 'needs_manual_reconciliation') || cancellations.some((c) => c.state === 'needs_manual_reconciliation')) {
    blocks.push({ code: 'manual_reconciliation_required', message: 'An earlier Sandbox request needs manual reconciliation by an administrator before anything else can be done.' });
  }
  if (hasUnresolvedCriticalDiscrepancy(db, originalItem.id)) {
    blocks.push({ code: 'discrepancy_unresolved', message: 'PayPal Sandbox reported data that does not match what was sent. An administrator must review the discrepancy first.' });
  }
  if (submissions.some((s) => (ACTIVE_SUBMISSION_STATES as string[]).includes(s.state))) {
    blocks.push({ code: 'submission_in_progress', message: 'A recovery payout request is still being sent or its outcome is not yet known.' });
  }
  if (cancellations.some((c) => (ACTIVE_CANCELLATION_STATES as string[]).includes(c.state))) {
    blocks.push({ code: 'cancellation_in_progress', message: 'An approved cancellation is still in progress.' });
  }
  const openProposal = db.prepare("SELECT * FROM payout_proposals WHERE original_item_id = ? AND status = 'pending_approval'").get(originalItem.id) as
    | ProposalRow
    | undefined;
  if (openProposal && openProposal.id !== options.ignoreProposalId) {
    blocks.push({ code: 'proposal_open', message: 'A proposal for this payment is already awaiting approval.' });
  }

  /* Reissue */
  const reissueReasons: string[] = [];
  const latestRecovery = recoveries.at(-1);
  const target = latestRecovery ?? original;
  let statusCheckRequired = false;
  const expectedCaseState = options.ignoreProposalId && openProposal?.id === options.ignoreProposalId ? openProposal.previous_case_state : caseRow.state;
  if (expectedCaseState !== 'open' && expectedCaseState !== 'investigating') reissueReasons.push('A reissue can only be proposed while the case is open or under investigation.');
  if (!original.provider) {
    reissueReasons.push('The payment provider has not reported a status for the original payment, so a failure is not confirmed.');
  } else if (!REISSUE_ELIGIBLE_STATUSES.includes(original.provider.status)) {
    reissueReasons.push(`The provider reports the original payment as ${original.provider.status}. A reissue needs a confirmed FAILED or RETURNED status.`);
  }
  if (recoveries.some((r) => r.provider?.status === 'SUCCESS')) reissueReasons.push('A recovery payment has already been reported as SUCCESS.');
  if (latestRecovery) {
    const status = latestRecovery.provider?.status;
    if (!status) reissueReasons.push(`The status of recovery payment ${latestRecovery.item.payment_reference} is not known yet.`);
    else if (status === 'BLOCKED') reissueReasons.push(`Recovery payment ${latestRecovery.item.payment_reference} is BLOCKED by the provider and needs a compliance review, not a reissue.`);
    else if (!REISSUE_ELIGIBLE_STATUSES.includes(status) && status !== 'SUCCESS') {
      reissueReasons.push(`Recovery payment ${latestRecovery.item.payment_reference} is still ${status}.`);
    } else if (latestRecovery.provider?.mode === 'sandbox' && !latestRecovery.checkFresh) {
      statusCheckRequired = true;
    }
  }
  const attemptNumber = recoveries.length + 1;
  if (attemptNumber > PAYOUT_LIMITS.maxRecoveryAttempts) reissueReasons.push(`The limit of ${PAYOUT_LIMITS.maxRecoveryAttempts} recovery attempts for one payment has been reached.`);
  let allowlistEntry: AllowlistEntry | null = null;
  if (originalItem.receiver_type !== 'EMAIL') {
    reissueReasons.push('Sandbox payment actions only support email receivers.');
  } else {
    allowlistEntry = findActiveEntry(db, caseRow.organisation_id, originalItem.receiver_type, originalItem.receiver_value);
    if (!allowlistEntry) reissueReasons.push('The original receiver is not an active entry on the Sandbox receiver allowlist.');
  }
  if (!isPayoutCurrency(originalItem.currency)) reissueReasons.push('The currency is not supported for Sandbox payment actions.');
  if (originalItem.amount_minor > PAYOUT_LIMITS.maxPerPayoutMinor) reissueReasons.push('The amount is above the per-payout limit.');
  const senderItemId = attemptNumber <= PAYOUT_LIMITS.maxRecoveryAttempts ? recoverySenderItemId(originalItem.payment_reference, attemptNumber) : null;
  if (senderItemId && senderItemId.length > SENDER_ITEM_ID_MAX_LENGTH) reissueReasons.push('The payment reference is too long for a PayPal sender item ID.');

  /* Cancel unclaimed */
  const cancelReasons: string[] = [];
  let cancelTarget: Attempt | null = null;
  let cancelCheckRequired = false;
  const expectedCancelState = options.ignoreProposalId && openProposal?.id === options.ignoreProposalId ? openProposal.previous_case_state : caseRow.state;
  if (expectedCancelState !== 'recovery_submitted') cancelReasons.push('A cancellation can only be proposed while a Sandbox recovery payout is in progress.');
  if (!latestRecovery || latestRecovery.provider?.mode !== 'sandbox') {
    cancelReasons.push('There is no PayPal Sandbox recovery payout to cancel.');
  } else {
    cancelTarget = latestRecovery;
    if (latestRecovery.provider.status !== 'UNCLAIMED') {
      cancelReasons.push(`Only an UNCLAIMED payout can be cancelled. PayPal Sandbox last reported ${latestRecovery.provider.status}.`);
    } else if (!latestRecovery.checkFresh || latestRecovery.latestCheck?.item_status !== 'UNCLAIMED') {
      cancelCheckRequired = true;
    }
  }

  const blocked = blocks.length > 0;
  return {
    caseRow,
    original,
    recoveries,
    fingerprint,
    blocks,
    openProposal,
    reissue: {
      available: !blocked && reissueReasons.length === 0,
      reasons: reissueReasons,
      statusCheckRequired,
      target,
      attemptNumber: attemptNumber <= PAYOUT_LIMITS.maxRecoveryAttempts ? attemptNumber : null,
      senderItemId,
      allowlistEntry,
    },
    cancel: { available: !blocked && cancelReasons.length === 0, reasons: cancelReasons, statusCheckRequired: cancelCheckRequired, target: cancelTarget },
  };
}
