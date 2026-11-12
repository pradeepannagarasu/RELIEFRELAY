import { Router } from 'express';
import { z } from 'zod';
import { forPayPalTargetDeep, type PayPalTarget } from '@shared/domain/payouts';
import { parseInput, requestContext } from '../lib/validation';
import type { InvestigationService } from '../services/investigationService';

const CaseParam = z.object({ id: z.string().regex(/^case_[A-Za-z0-9_-]{1,64}$/) });
const InvestigationParam = CaseParam.extend({ investigationId: z.string().regex(/^inv_[A-Za-z0-9-]{1,64}$/) });
const RunBody = z.strictObject({ caseVersion: z.number().int().min(1) });

/** Mounted at /cases/:id/investigations. Responses are worded for the bound PayPal target, like payment actions. */
export function investigationsRouter(service: InvestigationService, target: () => PayPalTarget | null = () => null): Router {
  const router = Router({ mergeParams: true });
  const out = <T>(body: T): T => forPayPalTargetDeep(body, target());

  router.get('/', (req, res) => {
    const { id } = parseInput(CaseParam, req.params, 'case id');
    res.json(out(service.list(requestContext(req), id)));
  });

  router.get('/:investigationId', (req, res) => {
    const { id, investigationId } = parseInput(InvestigationParam, req.params, 'investigation id');
    res.json(out(service.get(requestContext(req), id, investigationId)));
  });

  // Not tied to the client connection: if the browser disconnects, the recorded attempt still completes.
  router.post('/', async (req, res) => {
    const { id } = parseInput(CaseParam, req.params, 'case id');
    const { caseVersion } = parseInput(RunBody, req.body, 'investigation request');
    const detail = await service.run(requestContext(req), id, caseVersion);
    if (!res.writableEnded && !res.destroyed) res.status(201).json(out(detail));
  });

  return router;
}
