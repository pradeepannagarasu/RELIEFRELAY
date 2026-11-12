import { Router } from 'express';
import { z } from 'zod';
import { CASE_SORT_FIELDS } from '@shared/api/contracts';
import { NEXT_ACTION_CODES } from '@shared/domain/cases';
import { PAYOUT_ITEM_STATUSES } from '@shared/domain/paypal';
import { CASE_BASES, CASE_STATES } from '@shared/domain/types';
import { parseInput, requestContext } from '../lib/validation';
import { NOTE_MAX_LENGTH, type CaseService } from '../services/caseService';

const IdParam = z.object({ id: z.string().regex(/^case_[A-Za-z0-9_-]{1,64}$/) });
const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(PAYOUT_ITEM_STATUSES).optional(),
  source: z.enum(['provider', 'imported']).optional(),
  state: z.enum([...CASE_STATES, 'active', 'all']).optional(),
  nextAction: z.enum(NEXT_ACTION_CODES).optional(),
  basis: z.enum(CASE_BASES).optional(),
  batch: z.string().max(80).optional(),
  assignee: z.enum(['me', 'unassigned']).optional(),
  import: z.string().max(80).optional(),
  sort: z.enum(CASE_SORT_FIELDS).default('updated'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const NoteBody = z.object({ body: z.string().trim().min(1).max(NOTE_MAX_LENGTH) });
const AssignBody = z.object({ expectedVersion: z.number().int().min(1) });

export function casesRouter(service: CaseService): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await service.list(requestContext(req), parseInput(ListQuery, req.query, 'filter')));
  });

  router.get('/:id', async (req, res) => {
    const { id } = parseInput(IdParam, req.params, 'case id');
    res.json(await service.get(requestContext(req), id));
  });

  router.post('/:id/notes', async (req, res) => {
    const { id } = parseInput(IdParam, req.params, 'case id');
    const { body } = parseInput(NoteBody, req.body, 'note');
    res.status(201).json(await service.addNote(requestContext(req), id, body));
  });

  router.post('/:id/assign', async (req, res) => {
    const { id } = parseInput(IdParam, req.params, 'case id');
    const { expectedVersion } = parseInput(AssignBody, req.body, 'assignment');
    res.json(await service.assignToMe(requestContext(req), id, expectedVersion));
  });

  return router;
}
