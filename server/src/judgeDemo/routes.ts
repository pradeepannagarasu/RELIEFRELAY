import { Router } from 'express';
import { z } from 'zod';
import type { JudgeScenarioResponse, JudgeScenariosResponse } from '@shared/api/contracts';
import type { Db } from '../db/connection';
import { AppError } from '../lib/errors';
import { parseInput, requestContext } from '../lib/validation';
import { DEMO_WRITE_HEADER } from '../middleware/auth';
import { assertRole } from '../services/context';
import { countJudgeScenarios, createJudgeScenario, JUDGE_OUTCOMES, JUDGE_SETTLE_MS, JudgeScenarioLimitError, MAX_JUDGE_SCENARIOS } from './scenarios';

const CreateBody = z.strictObject({ outcome: z.enum(JUDGE_OUTCOMES) });

/** Judge Demo only: creates fresh synthetic cases whose simulated recovery payout will end in a chosen outcome. */
export function judgeDemoRouter(db: Db, clock: () => Date): Router {
  const router = Router();

  router.get('/scenarios', (req, res) => {
    const ctx = requestContext(req);
    const body: JudgeScenariosResponse = {
      outcomes: [...JUDGE_OUTCOMES],
      created: countJudgeScenarios(db, ctx.actor.organisationId),
      max: MAX_JUDGE_SCENARIOS,
      settleSeconds: JUDGE_SETTLE_MS / 1000,
    };
    res.json(body);
  });

  router.post('/scenarios', (req, res) => {
    const ctx = requestContext(req);
    if (req.headers[DEMO_WRITE_HEADER] !== '1') throw new AppError('forbidden', 'Creating a scenario must come from the ReliefRelay app.');
    assertRole(db, ctx, ['operator', 'approver'], 'demo.judge_scenario_created', 'payment_case', null);
    const { outcome } = parseInput(CreateBody, req.body, 'scenario');
    try {
      const result = createJudgeScenario(db, { organisationId: ctx.actor.organisationId, outcome, now: clock(), requestedBy: ctx.actor.user.displayName });
      const body: JudgeScenarioResponse = { caseId: result.caseId, caseReference: result.caseReference, outcome };
      res.status(201).json(body);
    } catch (error) {
      if (error instanceof JudgeScenarioLimitError) throw new AppError('conflict', error.message);
      throw error;
    }
  });

  return router;
}
