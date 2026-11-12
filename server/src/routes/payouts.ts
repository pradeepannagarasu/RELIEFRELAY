import { Router } from 'express';
import { z } from 'zod';
import { forPayPalTargetDeep, PROPOSAL_ACTIONS, PROPOSAL_REASON_CODES, PROPOSAL_STATUSES, type PayPalTarget } from '@shared/domain/payouts';
import { parseInput, requestContext } from '../lib/validation';
import type { PayoutService } from '../payouts/payoutService';

const CaseParam = z.object({ id: z.string().regex(/^case_[A-Za-z0-9_-]{1,64}$/) });
const ProposalParam = z.object({ id: z.string().regex(/^prop_[A-Za-z0-9-]{1,64}$/) });
const SubmissionParam = z.object({ id: z.string().regex(/^sub_[A-Za-z0-9-]{1,64}$/) });
const CancellationParam = z.object({ id: z.string().regex(/^can_[A-Za-z0-9-]{1,64}$/) });
const DiscrepancyParam = z.object({ id: z.string().regex(/^dis_[A-Za-z0-9-]{1,64}$/) });

const StatusCheckBody = z.strictObject({ itemId: z.string().regex(/^itm_[A-Za-z0-9_-]{1,80}$/) });
const CreateProposalBody = z.strictObject({
  action: z.enum(PROPOSAL_ACTIONS),
  reasonCode: z.enum(PROPOSAL_REASON_CODES),
  justification: z.string().trim().min(10).max(1000),
  attestation: z.literal(true),
  caseVersion: z.number().int().min(1),
  providerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const ApproveBody = z.strictObject({ proposalVersion: z.number().int().min(1), confirmation: z.string().min(1).max(200) });
const DecideBody = z.strictObject({ proposalVersion: z.number().int().min(1), reason: z.string().trim().min(5).max(500) });
const ListQuery = z.object({ status: z.enum(PROPOSAL_STATUSES).optional() });
const ReconcileBody = z.strictObject({
  action: z.enum(['link_batch', 'record_not_created']),
  providerBatchId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
  note: z.string().trim().max(1000).optional(),
});
const ResolveBody = z.strictObject({ note: z.string().trim().min(10).max(1000) });

/**
 * Payment-action routes mounted under /api. Every write is validated again by the service and the database.
 * Responses are worded for the PayPal target the database is bound to, so local-stub data never reads as PayPal Sandbox.
 */
export function payoutsRouter(service: PayoutService, target: () => PayPalTarget | null): Router {
  const router = Router();
  const out = <T>(body: T): T => forPayPalTargetDeep(body, target());

  router.get('/cases/:id/payment-actions', async (req, res) => {
    const { id } = parseInput(CaseParam, req.params, 'case id');
    res.json(out(await service.caseActions(requestContext(req), id)));
  });

  router.post('/cases/:id/payment-actions/status-checks', async (req, res) => {
    const { id } = parseInput(CaseParam, req.params, 'case id');
    const { itemId } = parseInput(StatusCheckBody, req.body, 'status check request');
    res.status(201).json(out(await service.checkStatus(requestContext(req), id, itemId)));
  });

  router.post('/cases/:id/proposals', async (req, res) => {
    const { id } = parseInput(CaseParam, req.params, 'case id');
    const body = parseInput(CreateProposalBody, req.body, 'proposal');
    res.status(201).json(out({ proposal: await service.createProposal(requestContext(req), id, body) }));
  });

  router.get('/proposals', async (req, res) => {
    const { status } = parseInput(ListQuery, req.query, 'proposal filter');
    res.json(out(await service.listProposals(requestContext(req), status)));
  });

  router.get('/proposals/:id', async (req, res) => {
    const { id } = parseInput(ProposalParam, req.params, 'proposal id');
    res.json(out({ proposal: await service.getProposal(requestContext(req), id) }));
  });

  // Not tied to the client connection: once approval is recorded, sending completes even if the browser disconnects.
  router.post('/proposals/:id/approve', async (req, res) => {
    const { id } = parseInput(ProposalParam, req.params, 'proposal id');
    const body = parseInput(ApproveBody, req.body, 'approval');
    const proposal = await service.approve(requestContext(req), id, body);
    if (!res.writableEnded && !res.destroyed) res.json(out({ proposal }));
  });

  router.post('/proposals/:id/reject', async (req, res) => {
    const { id } = parseInput(ProposalParam, req.params, 'proposal id');
    const body = parseInput(DecideBody, req.body, 'rejection');
    res.json(out({ proposal: await service.reject(requestContext(req), id, body) }));
  });

  router.post('/proposals/:id/withdraw', async (req, res) => {
    const { id } = parseInput(ProposalParam, req.params, 'proposal id');
    const body = parseInput(DecideBody, req.body, 'withdrawal');
    res.json(out({ proposal: await service.withdraw(requestContext(req), id, body) }));
  });

  router.post('/submissions/:id/retry', async (req, res) => {
    const { id } = parseInput(SubmissionParam, req.params, 'submission id');
    res.json(out(await service.retrySubmission(requestContext(req), id)));
  });

  router.post('/submissions/:id/reconcile', async (req, res) => {
    const { id } = parseInput(SubmissionParam, req.params, 'submission id');
    const body = parseInput(ReconcileBody, req.body, 'reconciliation');
    res.json(out(await service.reconcileSubmission(requestContext(req), id, body)));
  });

  router.post('/cancellations/:id/recheck', async (req, res) => {
    const { id } = parseInput(CancellationParam, req.params, 'cancellation id');
    res.json(out(await service.recheckCancellation(requestContext(req), id)));
  });

  router.post('/discrepancies/:id/resolve', async (req, res) => {
    const { id } = parseInput(DiscrepancyParam, req.params, 'discrepancy id');
    const { note } = parseInput(ResolveBody, req.body, 'resolution');
    res.json(out(await service.resolveDiscrepancy(requestContext(req), id, note)));
  });

  return router;
}
