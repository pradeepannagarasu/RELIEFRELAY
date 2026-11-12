import { openDatabase } from '../db/connection';
import { AppError } from '../lib/errors';
import { findUser } from '../repositories/sqlite/readModel';
import { createInvestigationService } from '../services/investigationService';
import { failedResponse, scriptedProvider } from './aiFixtures';

/** Child process used by the daily-limit race test: waits for a start time, then tries to start one investigation. */
const [path, caseId, caseVersion, limit, startAt] = process.argv.slice(2);
const db = openDatabase(path!, { busyTimeoutMs: 10_000 });
const user = findUser(db, 'usr_lena')!;
const service = createInvestigationService({
  db,
  clock: () => new Date('2026-11-10T12:00:00.000Z'),
  provider: scriptedProvider(failedResponse('provider_unavailable')),
  dailyLimit: Number(limit),
  timeoutMs: 45_000,
});

while (Date.now() < Number(startAt)) {
  // Spin briefly so every worker starts its transaction at the same moment.
}

service
  .run({ actor: { user, organisationId: user.organisationId }, requestId: null }, caseId!, Number(caseVersion))
  .then(() => process.stdout.write(JSON.stringify({ ok: true })))
  .catch((error: unknown) => process.stdout.write(JSON.stringify({ ok: false, code: error instanceof AppError ? error.code : String(error) })))
  .finally(() => db.close());
