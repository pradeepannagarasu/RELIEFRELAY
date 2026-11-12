import { money, type Money } from '@shared/domain/money';
import { UNCLAIMED_AUTO_RETURN_DAYS, type PayoutBatchStatus, type PayoutWebhookEventType } from '@shared/domain/paypal';
import type {
  BatchKind,
  CaseState,
  PaymentBatch,
  PaymentCase,
  PaymentDataset,
  PaymentEvent,
  PaymentItem,
  ProviderRecord,
  User,
} from '@shared/domain/types';

/*
 * Entirely fictional demonstration data. No real organisation, programme or person is represented.
 * Recipient references are random pseudonyms and every receiver identifier uses the reserved example.org domain.
 * All provider identifiers carry a SIM- prefix because no request was sent to PayPal.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const ORGANISATION = { id: 'org_demo', name: 'Meridian Aid (demo)', isSynthetic: true } as const;

const USERS: User[] = [
  { id: 'usr_lena', organisationId: ORGANISATION.id, displayName: 'Lena Hartmann', email: 'lena.hartmann@example.org', role: 'operator' },
  { id: 'usr_samuel', organisationId: ORGANISATION.id, displayName: 'Samuel Mensah', email: 'samuel.mensah@example.org', role: 'approver' },
  { id: 'usr_priya', organisationId: ORGANISATION.id, displayName: 'Priya Raman', email: 'priya.raman@example.org', role: 'admin' },
  { id: 'usr_tomas', organisationId: ORGANISATION.id, displayName: 'Tomas Novak', email: 'tomas.novak@example.org', role: 'viewer' },
];
export const DEMO_SESSION_USER_ID = 'usr_lena';

/**
 * The synthetic receiver behind a seeded masked identifier: a•••7@example.org belongs to
 * a.ben-xxxxxx.7@example.org. Only reserved example.org addresses are ever generated.
 */
export function syntheticReceiverFor(item: Pick<PaymentItem, 'recipientMasked' | 'recipientReference'>): string {
  const match = /^(.)•••(.)@example\.org$/.exec(item.recipientMasked);
  if (!match) throw new Error(`Unexpected seeded receiver mask ${item.recipientMasked}`);
  return `${match[1]}.${item.recipientReference.toLowerCase()}.${match[2]}@example.org`;
}

const OPERATOR = 'usr_lena';
const APPROVER = 'usr_samuel';
const ADMIN = 'usr_priya';

interface CaseStep {
  state: CaseState;
  /** Hours before "now". */
  hoursAgo: number;
  actor: string;
  summary: string;
}

type SeededStatus = 'SUCCESS' | 'FAILED' | 'UNCLAIMED' | 'RETURNED' | 'ONHOLD' | 'BLOCKED';

interface ExceptionSpec {
  status: Exclude<SeededStatus, 'SUCCESS'>;
  errorCode?: string;
  steps: CaseStep[];
  /** Adds a recovery item, in the recovery batch, that the provider reports as delivered. */
  recovered?: { summary: string };
  closure?: string;
}

interface BatchSpec {
  key: string;
  kind: BatchKind;
  reference: string;
  programme: string;
  submittedDaysAgo: number;
  status: PayoutBatchStatus;
  tiersMinor: number[];
  successCount: number;
  pendingCount: number;
  exceptions: ExceptionSpec[];
}

const BATCHES: BatchSpec[] = [
  {
    key: 'b1',
    kind: 'disbursement',
    reference: 'RR-B-2026-014',
    programme: 'Flood response cash assistance, round 1',
    submittedDaysAgo: 52,
    status: 'SUCCESS',
    tiersMinor: [12000, 18000, 24000],
    successCount: 34,
    pendingCount: 0,
    exceptions: [
      {
        status: 'RETURNED',
        steps: [
          { state: 'investigating', hoursAgo: 20 * 24, actor: OPERATOR, summary: 'Investigation started.' },
          { state: 'awaiting_approval', hoursAgo: 14 * 24, actor: OPERATOR, summary: 'Proposed reissue to a receiver identifier re-verified by the programme team.' },
          { state: 'recovery_submitted', hoursAgo: 12 * 24, actor: APPROVER, summary: 'Reissue approved and submitted.' },
        ],
        recovered: { summary: 'Provider confirmed the recovery payment was delivered.' },
      },
      {
        status: 'RETURNED',
        steps: [
          { state: 'investigating', hoursAgo: 6 * 24, actor: OPERATOR, summary: 'Investigation started.' },
          { state: 'awaiting_approval', hoursAgo: 3, actor: OPERATOR, summary: 'Proposed reissue after the programme team re-verified the receiver identifier.' },
        ],
      },
      {
        status: 'RETURNED',
        steps: [{ state: 'investigating', hoursAgo: 2 * 24, actor: OPERATOR, summary: 'Investigation started.' }],
      },
      {
        status: 'FAILED',
        errorCode: 'RECEIVER_ACCOUNT_LOCKED',
        steps: [
          { state: 'investigating', hoursAgo: 50 * 24, actor: OPERATOR, summary: 'Investigation started.' },
          { state: 'awaiting_approval', hoursAgo: 13 * 24, actor: OPERATOR, summary: 'Proposed reissue to an alternative receiver identifier supplied by the programme team.' },
          { state: 'recovery_submitted', hoursAgo: 12 * 24, actor: APPROVER, summary: 'Reissue approved and submitted.' },
        ],
        recovered: { summary: 'Provider confirmed the recovery payment was delivered.' },
      },
      {
        status: 'FAILED',
        errorCode: 'RECEIVER_UNCONFIRMED',
        steps: [{ state: 'investigating', hoursAgo: 49 * 24, actor: OPERATOR, summary: 'Investigation started.' }],
        closure:
          'Programme team confirmed this recipient reference was withdrawn from the programme before payment. No reissue requested.',
      },
      {
        status: 'FAILED',
        errorCode: 'RECEIVING_LIMIT_EXCEEDED',
        steps: [{ state: 'investigating', hoursAgo: 26, actor: OPERATOR, summary: 'Investigation started.' }],
      },
    ],
  },
  {
    key: 'b2',
    kind: 'disbursement',
    reference: 'RR-B-2026-015',
    programme: 'Flood response cash assistance, round 2',
    submittedDaysAgo: 24,
    status: 'SUCCESS',
    tiersMinor: [12000, 18000, 24000],
    successCount: 26,
    pendingCount: 0,
    exceptions: [
      { status: 'UNCLAIMED', steps: [] },
      { status: 'UNCLAIMED', steps: [] },
      {
        status: 'UNCLAIMED',
        steps: [{ state: 'investigating', hoursAgo: 22, actor: OPERATOR, summary: 'Investigation started.' }],
      },
      {
        status: 'UNCLAIMED',
        steps: [
          { state: 'investigating', hoursAgo: 2 * 24, actor: OPERATOR, summary: 'Investigation started.' },
          { state: 'awaiting_approval', hoursAgo: 5, actor: OPERATOR, summary: 'Proposed cancelling the unclaimed item and reissuing to a corrected receiver identifier.' },
        ],
      },
      { status: 'BLOCKED', steps: [] },
      {
        status: 'ONHOLD',
        steps: [{ state: 'investigating', hoursAgo: 3 * 24, actor: OPERATOR, summary: 'Investigation started.' }],
      },
    ],
  },
  {
    key: 'b5',
    kind: 'recovery',
    reference: 'RR-B-2026-016',
    programme: 'Approved recovery reissues',
    submittedDaysAgo: 12,
    status: 'SUCCESS',
    tiersMinor: [],
    successCount: 0,
    pendingCount: 0,
    exceptions: [],
  },
  {
    key: 'b3',
    kind: 'disbursement',
    reference: 'RR-B-2026-017',
    programme: 'Winter preparedness top-up',
    submittedDaysAgo: 9,
    status: 'SUCCESS',
    tiersMinor: [7500, 11000],
    successCount: 23,
    pendingCount: 0,
    exceptions: [
      { status: 'UNCLAIMED', steps: [] },
      { status: 'UNCLAIMED', steps: [] },
      {
        status: 'UNCLAIMED',
        steps: [{ state: 'investigating', hoursAgo: 6, actor: OPERATOR, summary: 'Investigation started.' }],
      },
      { status: 'FAILED', errorCode: 'RECEIVER_ACCOUNT_LOCKED', steps: [] },
      { status: 'FAILED', errorCode: 'RECEIVING_LIMIT_EXCEEDED', steps: [] },
    ],
  },
  {
    key: 'b4',
    kind: 'disbursement',
    reference: 'RR-B-2026-018',
    programme: 'Livelihood recovery grants, cohort A',
    submittedDaysAgo: 26 / 24,
    status: 'PROCESSING',
    tiersMinor: [30000, 45000],
    successCount: 11,
    pendingCount: 7,
    exceptions: [],
  },
];

const ITEM_EVENT: Record<SeededStatus, PayoutWebhookEventType> = {
  SUCCESS: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  FAILED: 'PAYMENT.PAYOUTS-ITEM.FAILED',
  UNCLAIMED: 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
  RETURNED: 'PAYMENT.PAYOUTS-ITEM.RETURNED',
  ONHOLD: 'PAYMENT.PAYOUTS-ITEM.HELD',
  BLOCKED: 'PAYMENT.PAYOUTS-ITEM.BLOCKED',
};

/** Small deterministic PRNG so the demo data is identical on every start. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createSyntheticDataset(now: Date): PaymentDataset {
  const random = mulberry32(20_261_110);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
  const code = (length: number) => Array.from({ length }, () => pick([...ALPHABET])).join('');
  const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  const usd = (minor: number): Money => money('USD', minor);
  const maskedEmail = () => `${pick([...'abcdefghjkmnprstw'])}•••${Math.floor(random() * 10)}@example.org`;

  const batches: PaymentBatch[] = [];
  const items: PaymentItem[] = [];
  const cases: PaymentCase[] = [];
  const events: PaymentEvent[] = [];
  let eventSeq = 0;
  let caseSeq = 1040;

  const addEvent = (event: Omit<PaymentEvent, 'id' | 'organisationId'>) => {
    eventSeq += 1;
    events.push({ id: `evt_${String(eventSeq).padStart(5, '0')}`, organisationId: ORGANISATION.id, ...event });
  };

  const baseEvent = {
    paymentItemId: null,
    caseId: null,
    importId: null,
    providerEventType: null,
    previousStatus: null,
    newStatus: null,
    previousCaseState: null,
    newCaseState: null,
    actorUserId: null,
  } as const;

  const recoveryBatchSpec = BATCHES.find((b) => b.kind === 'recovery');
  const pendingRecoveries: { original: PaymentItem; caseId: string; submittedHoursAgo: number; summary: string }[] = [];

  for (const spec of BATCHES) {
    const submittedMsAgo = spec.submittedDaysAgo * DAY;
    const batch: PaymentBatch = {
      id: `bat_${spec.key}`,
      organisationId: ORGANISATION.id,
      kind: spec.kind,
      origin: 'provider_submission',
      sourceImportId: null,
      reference: spec.reference,
      programme: spec.programme,
      senderBatchId: spec.reference,
      providerBatchId: `SIM-PB-${code(12)}`,
      providerMode: 'simulation',
      status: spec.status,
      importedAt: at(submittedMsAgo + HOUR),
      importedByUserId: spec.kind === 'recovery' ? APPROVER : ADMIN,
      submittedAt: at(submittedMsAgo),
    };
    batches.push(batch);
    if (spec.kind === 'recovery') continue;

    const statusPlan: (ExceptionSpec | 'SUCCESS' | 'PENDING')[] = [
      ...Array<'SUCCESS'>(spec.successCount).fill('SUCCESS'),
      ...Array<'PENDING'>(spec.pendingCount).fill('PENDING'),
      ...spec.exceptions,
    ];
    for (let i = statusPlan.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [statusPlan[i], statusPlan[j]] = [statusPlan[j]!, statusPlan[i]!];
    }

    addEvent({
      ...baseEvent,
      batchId: batch.id,
      type: 'batch_imported',
      source: 'operator',
      occurredAt: batch.importedAt,
      actorUserId: batch.importedByUserId,
      summary: `Imported ${statusPlan.length} payment records and passed validation.`,
    });
    addEvent({
      ...baseEvent,
      batchId: batch.id,
      type: 'batch_submitted',
      source: 'simulation',
      occurredAt: at(submittedMsAgo),
      actorUserId: APPROVER,
      providerEventType: 'PAYMENT.PAYOUTSBATCH.PROCESSING',
      summary: 'Batch submitted to the simulated provider after approval.',
    });

    statusPlan.forEach((plan, index) => {
      const status: SeededStatus | 'PENDING' = typeof plan === 'string' ? plan : plan.status;
      const exception = typeof plan === 'string' ? null : plan;
      const reactionMs = Math.min(submittedMsAgo - 2 * HOUR, (5 + random() * 360) * 60 * 1000);
      const firstStatusAgo = submittedMsAgo - reactionMs;
      const finalStatusAgo = status === 'RETURNED' ? firstStatusAgo - UNCLAIMED_AUTO_RETURN_DAYS * DAY : firstStatusAgo;

      const providerRecord: ProviderRecord = {
        mode: 'simulation',
        providerItemId: `SIM-PI-${code(12)}`,
        providerTransactionId: status === 'SUCCESS' ? `SIM-TX-${code(14)}` : null,
        status,
        errorCode: exception?.errorCode ?? null,
        statusUpdatedAt: status === 'PENDING' ? at(submittedMsAgo) : at(finalStatusAgo),
      };
      const item: PaymentItem = {
        id: `itm_${spec.key}_${String(index + 1).padStart(3, '0')}`,
        batchId: batch.id,
        senderItemId: `${spec.reference}-${String(index + 1).padStart(4, '0')}`,
        recipientReference: `BEN-${code(6)}`,
        recipientType: 'EMAIL',
        recipientMasked: maskedEmail(),
        amount: usd(pick(spec.tiersMinor)),
        recoveryOfItemId: null,
        provider: providerRecord,
        imported: null,
      };
      items.push(item);

      if (status === 'PENDING') return;

      if (status === 'RETURNED') {
        addEvent({
          ...baseEvent,
          batchId: batch.id,
          paymentItemId: item.id,
          type: 'provider_status_changed',
          source: 'simulation',
          occurredAt: at(firstStatusAgo),
          providerEventType: ITEM_EVENT.UNCLAIMED,
          previousStatus: 'PENDING',
          newStatus: 'UNCLAIMED',
          summary: 'Provider reported the payout as unclaimed.',
        });
      }
      addEvent({
        ...baseEvent,
        batchId: batch.id,
        paymentItemId: item.id,
        type: 'provider_status_changed',
        source: 'simulation',
        occurredAt: at(finalStatusAgo),
        providerEventType: ITEM_EVENT[status],
        previousStatus: status === 'RETURNED' ? 'UNCLAIMED' : 'PENDING',
        newStatus: status,
        summary:
          status === 'SUCCESS'
            ? 'Provider reported the payout as delivered.'
            : status === 'RETURNED'
              ? `Provider returned the unclaimed payout after ${UNCLAIMED_AUTO_RETURN_DAYS} days.`
              : `Provider reported ${status}${providerRecord.errorCode ? ` (${providerRecord.errorCode})` : ''}.`,
      });

      if (!exception) return;

      caseSeq += 1;
      const openedAgo = finalStatusAgo - 60 * 1000;
      const paymentCase: PaymentCase = {
        id: `case_${caseSeq}`,
        reference: `RC-${caseSeq}`,
        organisationId: ORGANISATION.id,
        paymentItemId: item.id,
        state: 'open',
        basis: 'provider_confirmed',
        openingReason: 'provider_exception',
        openedAt: at(openedAgo),
        updatedAt: at(openedAgo),
        assigneeUserId: null,
        resolution: null,
        version: 1,
      };
      cases.push(paymentCase);
      addEvent({
        ...baseEvent,
        batchId: batch.id,
        paymentItemId: item.id,
        caseId: paymentCase.id,
        type: 'case_opened',
        source: 'system',
        occurredAt: paymentCase.openedAt,
        newCaseState: 'open',
        summary: `Case opened automatically for a ${status} payout.`,
      });

      const transition = (next: CaseState, hoursAgo: number, actor: string, summary: string, source: PaymentEvent['source'] = 'operator') => {
        addEvent({
          ...baseEvent,
          batchId: batch.id,
          paymentItemId: item.id,
          caseId: paymentCase.id,
          type: next === 'recovery_submitted' ? 'recovery_submitted' : 'case_state_changed',
          source,
          occurredAt: at(hoursAgo * HOUR),
          previousCaseState: paymentCase.state,
          newCaseState: next,
          actorUserId: source === 'system' ? null : actor,
          summary,
        });
        paymentCase.state = next;
        paymentCase.updatedAt = at(hoursAgo * HOUR);
        paymentCase.version += 1;
        if (next === 'investigating') paymentCase.assigneeUserId = actor;
      };

      for (const step of exception.steps) transition(step.state, step.hoursAgo, step.actor, step.summary);

      if (exception.closure) {
        const closedHoursAgo = (exception.steps.at(-1)?.hoursAgo ?? openedAgo / HOUR) - 9 * 24;
        transition('closed', closedHoursAgo, OPERATOR, exception.closure);
        paymentCase.resolution = {
          kind: 'closed_no_action',
          summary: exception.closure,
          resolvedAt: paymentCase.updatedAt,
          resolvedByUserId: OPERATOR,
          recoveryItemId: null,
        };
      }

      if (exception.recovered) {
        const submittedStep = exception.steps.find((s) => s.state === 'recovery_submitted');
        if (!submittedStep) throw new Error(`Recovered case ${paymentCase.reference} needs a recovery_submitted step`);
        pendingRecoveries.push({
          original: item,
          caseId: paymentCase.id,
          submittedHoursAgo: submittedStep.hoursAgo,
          summary: exception.recovered.summary,
        });
      }
    });
  }

  if (recoveryBatchSpec) {
    const recoveryBatch = batches.find((b) => b.kind === 'recovery');
    if (!recoveryBatch) throw new Error('Recovery batch missing');
    addEvent({
      ...baseEvent,
      batchId: recoveryBatch.id,
      type: 'batch_submitted',
      source: 'simulation',
      occurredAt: recoveryBatch.submittedAt ?? recoveryBatch.importedAt,
      actorUserId: APPROVER,
      providerEventType: 'PAYMENT.PAYOUTSBATCH.PROCESSING',
      summary: `Recovery batch of ${pendingRecoveries.length} approved reissues submitted to the simulated provider.`,
    });

    pendingRecoveries.forEach(({ original, caseId, submittedHoursAgo, summary }, index) => {
      const deliveredAgo = submittedHoursAgo * HOUR - 4 * HOUR;
      const recoveryDeliveredAt = at(deliveredAgo);
      const providerRecord: ProviderRecord = {
        mode: 'simulation',
        providerItemId: `SIM-PI-${code(12)}`,
        providerTransactionId: `SIM-TX-${code(14)}`,
        status: 'SUCCESS',
        errorCode: null,
        statusUpdatedAt: recoveryDeliveredAt,
      };
      const recoveryItem: PaymentItem = {
        id: `itm_${recoveryBatchSpec.key}_${String(index + 1).padStart(3, '0')}`,
        batchId: recoveryBatch.id,
        senderItemId: `${recoveryBatch.reference}-${String(index + 1).padStart(4, '0')}`,
        recipientReference: original.recipientReference,
        recipientType: original.recipientType,
        recipientMasked: maskedEmail(),
        amount: original.amount,
        recoveryOfItemId: original.id,
        provider: providerRecord,
        imported: null,
      };
      items.push(recoveryItem);
      addEvent({
        ...baseEvent,
        batchId: recoveryBatch.id,
        paymentItemId: recoveryItem.id,
        caseId,
        type: 'provider_status_changed',
        source: 'simulation',
        occurredAt: recoveryDeliveredAt,
        providerEventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
        previousStatus: 'PENDING',
        newStatus: 'SUCCESS',
        summary: 'Provider reported the recovery payout as delivered.',
      });

      const paymentCase = cases.find((c) => c.id === caseId);
      if (!paymentCase) throw new Error(`Case ${caseId} missing`);
      const resolvedAt = new Date(Date.parse(recoveryDeliveredAt) + 60 * 1000).toISOString();
      addEvent({
        ...baseEvent,
        batchId: original.batchId,
        paymentItemId: original.id,
        caseId,
        type: 'case_state_changed',
        source: 'system',
        occurredAt: resolvedAt,
        previousCaseState: paymentCase.state,
        newCaseState: 'resolved',
        summary,
      });
      paymentCase.state = 'resolved';
      paymentCase.updatedAt = resolvedAt;
      paymentCase.version += 1;
      paymentCase.resolution = {
        kind: 'recovered',
        summary,
        resolvedAt,
        resolvedByUserId: APPROVER,
        recoveryItemId: recoveryItem.id,
      };
    });
  }

  events.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));

  return { organisation: { ...ORGANISATION }, users: USERS.map((u) => ({ ...u })), batches, items, cases, events };
}
