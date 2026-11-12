import type { Db } from '../db/connection';

/** Allocates the next human-readable case reference. Must be called inside a write transaction. */
export function nextCaseReference(db: Db, organisationId: string): string {
  const updated = db
    .prepare("UPDATE counters SET value = value + 1 WHERE organisation_id = ? AND name = 'case_reference' RETURNING value")
    .get(organisationId) as { value: number } | undefined;
  if (updated) return `RC-${updated.value}`;
  db.prepare("INSERT INTO counters (organisation_id, name, value) VALUES (?, 'case_reference', 1001)").run(organisationId);
  return 'RC-1001';
}
