import type { CurrencyCode } from '@shared/domain/money';
import type { PayoutBatchStatus, PayoutItemStatus, PayoutWebhookEventType } from '@shared/domain/paypal';
import type {
  BatchKind,
  BatchOrigin,
  CaseBasis,
  CaseState,
  EventSource,
  ImportedStatusRecord,
  Organisation,
  PaymentBatch,
  PaymentCase,
  PaymentDataset,
  PaymentEvent,
  PaymentEventType,
  PaymentItem,
  ProviderRecord,
  RecipientType,
  Role,
  User,
} from '@shared/domain/types';
import type { Db } from '../../db/connection';

interface OrganisationRow {
  id: string;
  name: string;
  is_synthetic: number;
}
interface UserRow {
  id: string;
  organisation_id: string;
  display_name: string;
  email: string;
  role: Role;
}
export interface BatchRow {
  id: string;
  organisation_id: string;
  reference: string;
  kind: BatchKind;
  origin: BatchOrigin;
  programme: string;
  sender_batch_id: string | null;
  provider_mode: 'simulation' | 'sandbox' | null;
  provider_batch_id: string | null;
  provider_status: PayoutBatchStatus | null;
  submitted_at: string | null;
  created_by_user_id: string;
  source_import_id: string | null;
  created_at: string;
}
export interface ItemRow {
  id: string;
  organisation_id: string;
  batch_id: string;
  payment_reference: string;
  recipient_reference: string;
  receiver_type: RecipientType;
  receiver_masked: string;
  amount_minor: number;
  currency: CurrencyCode;
  fingerprint: string;
  recovery_of_item_id: string | null;
  source_import_row_id: string | null;
  created_at: string;
}
export interface ProviderRow {
  payment_item_id: string;
  mode: 'simulation' | 'sandbox';
  provider_item_id: string | null;
  provider_transaction_id: string | null;
  status: PayoutItemStatus;
  error_code: string | null;
  amount_minor: number;
  currency: CurrencyCode;
  status_updated_at: string;
}
export interface ObservationRow {
  seq: number;
  id: string;
  payment_item_id: string;
  import_id: string;
  import_row_id: string;
  row_number: number;
  status: PayoutItemStatus;
  status_at: string | null;
  error_code: string | null;
  claimed_provider_item_id: string | null;
  claimed_provider_transaction_id: string | null;
  recorded_at: string;
}
export interface CaseRow {
  id: string;
  organisation_id: string;
  reference: string;
  payment_item_id: string;
  state: CaseState;
  basis: CaseBasis;
  opening_reason: string;
  assignee_user_id: string | null;
  opened_at: string;
  updated_at: string;
  version: number;
  resolution_kind: 'recovered' | 'closed_no_action' | null;
  resolution_summary: string | null;
  resolved_at: string | null;
  resolved_by_user_id: string | null;
  recovery_item_id: string | null;
}
export interface EventRow {
  id: string;
  organisation_id: string;
  batch_id: string;
  payment_item_id: string | null;
  case_id: string | null;
  import_id: string | null;
  type: PaymentEventType;
  source: EventSource;
  occurred_at: string;
  provider_event_type: PayoutWebhookEventType | null;
  previous_status: PayoutItemStatus | null;
  new_status: PayoutItemStatus | null;
  previous_case_state: CaseState | null;
  new_case_state: CaseState | null;
  actor_user_id: string | null;
  summary: string;
}

export const toUser = (row: UserRow): User => ({
  id: row.id,
  organisationId: row.organisation_id,
  displayName: row.display_name,
  email: row.email,
  role: row.role,
});

export const toBatch = (row: BatchRow): PaymentBatch => ({
  id: row.id,
  organisationId: row.organisation_id,
  kind: row.kind,
  origin: row.origin,
  reference: row.reference,
  programme: row.programme,
  senderBatchId: row.sender_batch_id,
  providerBatchId: row.provider_batch_id,
  providerMode: row.provider_mode,
  status: row.provider_status,
  importedAt: row.created_at,
  importedByUserId: row.created_by_user_id,
  submittedAt: row.submitted_at,
  sourceImportId: row.source_import_id,
});

export const toProviderRecord = (row: ProviderRow): ProviderRecord => ({
  mode: row.mode,
  providerItemId: row.provider_item_id,
  providerTransactionId: row.provider_transaction_id,
  status: row.status,
  errorCode: row.error_code,
  statusUpdatedAt: row.status_updated_at,
});

export const toImportedRecord = (row: ObservationRow): ImportedStatusRecord => ({
  observationId: row.id,
  status: row.status,
  statusAt: row.status_at,
  errorCode: row.error_code,
  importId: row.import_id,
  rowNumber: row.row_number,
  recordedAt: row.recorded_at,
});

export function toItem(row: ItemRow, provider: ProviderRow | undefined, observation: ObservationRow | undefined): PaymentItem {
  return {
    id: row.id,
    batchId: row.batch_id,
    senderItemId: row.payment_reference,
    recipientReference: row.recipient_reference,
    recipientType: row.receiver_type,
    recipientMasked: row.receiver_masked,
    amount: { currency: row.currency, minor: row.amount_minor },
    recoveryOfItemId: row.recovery_of_item_id,
    provider: provider ? toProviderRecord(provider) : null,
    imported: observation ? toImportedRecord(observation) : null,
  };
}

export const toCase = (row: CaseRow): PaymentCase => ({
  id: row.id,
  reference: row.reference,
  organisationId: row.organisation_id,
  paymentItemId: row.payment_item_id,
  state: row.state,
  basis: row.basis,
  openingReason: row.opening_reason,
  openedAt: row.opened_at,
  updatedAt: row.updated_at,
  assigneeUserId: row.assignee_user_id,
  version: row.version,
  resolution: row.resolution_kind
    ? {
        kind: row.resolution_kind,
        summary: row.resolution_summary ?? '',
        resolvedAt: row.resolved_at ?? row.updated_at,
        resolvedByUserId: row.resolved_by_user_id ?? '',
        recoveryItemId: row.recovery_item_id,
      }
    : null,
});

export const toEvent = (row: EventRow): PaymentEvent => ({
  id: row.id,
  organisationId: row.organisation_id,
  batchId: row.batch_id,
  paymentItemId: row.payment_item_id,
  caseId: row.case_id,
  importId: row.import_id,
  type: row.type,
  source: row.source,
  occurredAt: row.occurred_at,
  providerEventType: row.provider_event_type,
  previousStatus: row.previous_status,
  newStatus: row.new_status,
  previousCaseState: row.previous_case_state,
  newCaseState: row.new_case_state,
  actorUserId: row.actor_user_id,
  summary: row.summary,
});

/**
 * The current imported status of each payment: the observation with the latest status date (or, when the file
 * gave no date, the latest recording time). Older observations remain stored and are never modified.
 */
export const CURRENT_OBSERVATIONS_SQL = `
  SELECT * FROM (
    SELECT o.*, row_number() OVER (
      PARTITION BY o.payment_item_id ORDER BY coalesce(o.status_at, o.recorded_at) DESC, o.seq DESC
    ) AS rn
    FROM status_observations o
    WHERE o.organisation_id = ?
  ) WHERE rn = 1`;

export function findUser(db: Db, userId: string): User | null {
  const row = db.prepare('SELECT id, organisation_id, display_name, email, role FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function findOrganisation(db: Db, organisationId: string): Organisation | null {
  const row = db.prepare('SELECT id, name, is_synthetic FROM organisations WHERE id = ?').get(organisationId) as OrganisationRow | undefined;
  return row ? { id: row.id, name: row.name, isSynthetic: row.is_synthetic === 1 } : null;
}

export function loadDataset(db: Db, organisationId: string): PaymentDataset | null {
  const organisation = findOrganisation(db, organisationId);
  if (!organisation) return null;
  const users = (db.prepare('SELECT * FROM users WHERE organisation_id = ? ORDER BY id').all(organisationId) as UserRow[]).map(toUser);
  const batches = (db.prepare('SELECT * FROM payment_batches WHERE organisation_id = ? ORDER BY created_at').all(organisationId) as BatchRow[]).map(
    toBatch,
  );
  const providers = new Map(
    (
      db
        .prepare('SELECT p.* FROM provider_transactions p JOIN payment_items i ON i.id = p.payment_item_id WHERE i.organisation_id = ?')
        .all(organisationId) as ProviderRow[]
    ).map((row) => [row.payment_item_id, row]),
  );
  const observations = new Map(
    (db.prepare(CURRENT_OBSERVATIONS_SQL).all(organisationId) as ObservationRow[]).map((row) => [row.payment_item_id, row]),
  );
  const items = (db.prepare('SELECT * FROM payment_items WHERE organisation_id = ? ORDER BY payment_reference').all(organisationId) as ItemRow[]).map(
    (row) => toItem(row, providers.get(row.id), observations.get(row.id)),
  );
  const cases = (db.prepare('SELECT * FROM payment_cases WHERE organisation_id = ? ORDER BY reference').all(organisationId) as CaseRow[]).map(toCase);
  const events = (db.prepare('SELECT * FROM payment_events WHERE organisation_id = ? ORDER BY occurred_at, id').all(organisationId) as EventRow[]).map(
    toEvent,
  );
  return { organisation, users, batches, items, cases, events };
}
