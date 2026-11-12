import type { PayoutCurrency } from '@shared/domain/payouts';
import type { Db } from '../db/connection';
import { addEntry, findActiveEntry } from '../payouts/allowlist';
import { createDemoScenario, type DemoScenarioResult } from '../payouts/demoScenario';

/** Matches the local stub's scripted outcome: PENDING first, then finalStatus once afterMs has passed. */
export interface ScriptedOutcome {
  finalStatus: string;
  afterMs: number;
}

/**
 * Judge Demo scenarios. Each outcome has its own reserved, synthetic receiver; the local PayPal stub reports that
 * outcome for any recovery payout sent to it, after a short PENDING period, so judges can watch status polling.
 */
export const JUDGE_OUTCOMES = ['SUCCESS', 'FAILED', 'RETURNED', 'UNCLAIMED'] as const;
export type JudgeOutcome = (typeof JUDGE_OUTCOMES)[number];

export const JUDGE_RECEIVERS: Record<JudgeOutcome, string> = {
  SUCCESS: 'judge-demo-success@personal.example.com',
  FAILED: 'judge-demo-failed@personal.example.com',
  RETURNED: 'judge-demo-returned@personal.example.com',
  UNCLAIMED: 'judge-demo-unclaimed@personal.example.com',
};

const SCENARIO_AMOUNTS: Record<JudgeOutcome, { amountMinor: number; currency: PayoutCurrency }> = {
  SUCCESS: { amountMinor: 1250, currency: 'GBP' },
  FAILED: { amountMinor: 4000, currency: 'USD' },
  RETURNED: { amountMinor: 2500, currency: 'EUR' },
  UNCLAIMED: { amountMinor: 3000, currency: 'GBP' },
};

/** How long a simulated recovery payout stays PENDING before the stub reports its outcome. */
export const JUDGE_SETTLE_MS = 20_000;
/** Upper bound on scenario cases judges can create until the organiser resets the demo. */
export const MAX_JUDGE_SCENARIOS = 150;

export function judgeOutcomeFor(receiver: string): ScriptedOutcome | null {
  const outcome = JUDGE_OUTCOMES.find((o) => JUDGE_RECEIVERS[o] === receiver.trim().toLowerCase());
  return outcome ? { finalStatus: outcome, afterMs: JUDGE_SETTLE_MS } : null;
}

/** Adds the four reserved scenario receivers to this (Judge Demo) database's allowlist. */
export function registerJudgeReceivers(db: Db, organisationId: string, now: Date): void {
  for (const outcome of JUDGE_OUTCOMES) {
    if (findActiveEntry(db, organisationId, 'EMAIL', JUDGE_RECEIVERS[outcome])) continue;
    addEntry(db, organisationId, JUDGE_RECEIVERS[outcome], `Judge Demo receiver (simulated ${outcome} outcome)`, now);
  }
}

export function countJudgeScenarios(db: Db, organisationId: string): number {
  return (db.prepare("SELECT count(*) AS n FROM payment_batches WHERE organisation_id = ? AND reference LIKE 'RR-B-JUDGE-%'").get(organisationId) as { n: number }).n;
}

export class JudgeScenarioLimitError extends Error {
  override name = 'JudgeScenarioLimitError';
}

export function createJudgeScenario(db: Db, input: { organisationId: string; outcome: JudgeOutcome; now: Date; requestedBy: string }): DemoScenarioResult & { outcome: JudgeOutcome } {
  if (countJudgeScenarios(db, input.organisationId) >= MAX_JUDGE_SCENARIOS) {
    throw new JudgeScenarioLimitError(`The Judge Demo already has ${MAX_JUDGE_SCENARIOS} scenario cases. Please use one of the existing scenario cases.`);
  }
  const result = createDemoScenario(db, {
    organisationId: input.organisationId,
    receiver: JUDGE_RECEIVERS[input.outcome],
    ...SCENARIO_AMOUNTS[input.outcome],
    now: input.now,
    labels: {
      programme: 'Judge Demo (synthetic, simulated payments)',
      referencePrefix: 'JUDGE',
      context: `Judge Demo (expected simulated recovery outcome: ${input.outcome})`,
      auditAction: 'demo.judge_scenario_created',
      auditReason: `Judge Demo scenario requested by ${input.requestedBy}; recovery payouts go to the local PayPal stub, which will report ${input.outcome}.`,
    },
  });
  return { ...result, outcome: input.outcome };
}
