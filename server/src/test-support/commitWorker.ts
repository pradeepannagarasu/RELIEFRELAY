import { openDatabase } from '../db/connection';
import { findUser } from '../repositories/sqlite/readModel';
import { createImportService } from '../services/importService';

/** Child process used by the concurrency test: waits for a start time, then tries to commit one import. */
const [path, importId, version, startAt] = process.argv.slice(2);
const db = openDatabase(path!, { busyTimeoutMs: 10_000 });
const user = findUser(db, 'usr_lena')!;
const service = createImportService(db, () => new Date('2026-11-10T12:00:00.000Z'));

while (Date.now() < Number(startAt)) {
  // Spin briefly so both workers start their transactions at the same moment.
}

service
  .commit({ actor: { user, organisationId: user.organisationId }, requestId: null }, importId!, { validationVersion: Number(version) })
  .then((result) => process.stdout.write(JSON.stringify({ ok: true, alreadyCommitted: result.alreadyCommitted })))
  .catch((error: unknown) => process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })))
  .finally(() => db.close());
