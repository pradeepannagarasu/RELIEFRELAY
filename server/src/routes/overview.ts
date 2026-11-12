import { Router } from 'express';
import type { ApprovalSources, OverviewResponse } from '@shared/api/contracts';
import { buildOverview } from '@shared/domain/overview';
import type { Db } from '../db/connection';
import { AppError } from '../lib/errors';
import { requireActor } from '../middleware/auth';
import { boundPayPalTarget } from '../payouts/target';
import { loadDataset } from '../repositories/sqlite/readModel';

/** Separates historical "awaiting approval" cases (no payment proposal) from current proposals and sent payouts. */
export function approvalSources(db: Db, organisationId: string): ApprovalSources {
  const count = (sql: string) => (db.prepare(sql).get(organisationId) as { n: number }).n;
  return {
    historicalAwaitingCases: count(
      `SELECT count(*) AS n FROM payment_cases c WHERE c.organisation_id = ? AND c.state = 'awaiting_approval'
         AND NOT EXISTS (SELECT 1 FROM payout_proposals p WHERE p.case_id = c.id AND p.status = 'pending_approval')`,
    ),
    pendingProposals: count("SELECT count(*) AS n FROM payout_proposals WHERE organisation_id = ? AND status = 'pending_approval'"),
    submittedPayouts: count("SELECT count(*) AS n FROM payout_submissions WHERE organisation_id = ? AND state = 'accepted'"),
    paypalTarget: boundPayPalTarget(db),
  };
}

export function overviewRouter(db: Db, clock: () => Date): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const actor = requireActor(req);
    const dataset = loadDataset(db, actor.organisationId);
    if (!dataset) throw new AppError('not_found', 'Organisation data not found.');
    const body: OverviewResponse = { ...buildOverview(dataset, clock()), approvalSources: approvalSources(db, actor.organisationId) };
    res.json(body);
  });

  return router;
}
