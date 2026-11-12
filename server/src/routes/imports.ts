import express, { Router } from 'express';
import { z } from 'zod';
import { IMPORT_FIELDS, IMPORT_LIMITS, ROW_ISSUE_CODES, ROW_OUTCOMES } from '@shared/domain/imports';
import type { Db } from '../db/connection';
import { buildSampleCsv, buildTemplateCsv } from '../imports/sampleFiles';
import { AppError } from '../lib/errors';
import { parseInput, requestContext } from '../lib/validation';
import type { ImportService } from '../services/importService';

const IdParam = z.object({ id: z.string().regex(/^imp_[0-9a-f-]{36}$/) });
const UploadQuery = z.object({ fileName: z.string().min(1).max(255) });
const MappingBody = z.object({
  mapping: z.partialRecord(z.enum(IMPORT_FIELDS), z.number().int().min(0).max(IMPORT_LIMITS.maxColumns - 1)),
});
const RowsQuery = z.object({
  outcome: z.enum(ROW_OUTCOMES).optional(),
  issue: z.enum(ROW_ISSUE_CODES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const CommitBody = z.object({ validationVersion: z.number().int().min(1), confirm: z.literal(true) });

function sendCsv(res: express.Response, fileName: string, body: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
}

export function importsRouter(service: ImportService, db: Db, clock: () => Date): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await service.list(requestContext(req)));
  });

  router.get('/template.csv', (_req, res) => {
    sendCsv(res, 'reliefrelay-import-template.csv', buildTemplateCsv());
  });

  router.get('/sample.csv', (req, res) => {
    const ctx = requestContext(req);
    sendCsv(res, 'reliefrelay-synthetic-sample.csv', buildSampleCsv(db, ctx.actor.organisationId, clock()));
  });

  router.post('/', express.raw({ type: () => true, limit: IMPORT_LIMITS.maxBytes }), async (req, res) => {
    const contentType = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'text/csv') {
      throw new AppError('unsupported_media_type', 'Upload the file as text/csv.');
    }
    const { fileName } = parseInput(UploadQuery, req.query, 'file name');
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await service.upload(requestContext(req), fileName, bytes);
    res.status(result.alreadyUploaded ? 200 : 201).json(result);
  });

  router.get('/:id', async (req, res) => {
    const { id } = parseInput(IdParam, req.params, 'import id');
    res.json(await service.get(requestContext(req), id));
  });

  router.put('/:id/mapping', async (req, res) => {
    const { id } = parseInput(IdParam, req.params, 'import id');
    const { mapping } = parseInput(MappingBody, req.body, 'column mapping');
    res.json(await service.applyMapping(requestContext(req), id, mapping));
  });

  router.get('/:id/rows', async (req, res) => {
    const { id } = parseInput(IdParam, req.params, 'import id');
    const query = parseInput(RowsQuery, req.query, 'filter');
    res.json(await service.rows(requestContext(req), id, query));
  });

  router.post('/:id/commit', async (req, res) => {
    const { id } = parseInput(IdParam, req.params, 'import id');
    const body = parseInput(CommitBody, req.body, 'confirmation');
    res.json(await service.commit(requestContext(req), id, { validationVersion: body.validationVersion }));
  });

  router.post('/:id/discard', async (req, res) => {
    const { id } = parseInput(IdParam, req.params, 'import id');
    res.json(await service.discard(requestContext(req), id));
  });

  return router;
}
