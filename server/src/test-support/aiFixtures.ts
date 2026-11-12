import type { InvestigationOutput } from '@shared/domain/investigation';
import type { AiProvider, AiRequest, AiResponse } from '../ai/provider';

export const TEST_MODEL = 'gpt-6.1-sol';

export const okResponse = (output: unknown): AiResponse => ({
  ok: true,
  output,
  model: 'gpt-6.1-sol-2026-10-01',
  responseId: 'resp_test_1',
  usage: { inputTokens: 2400, outputTokens: 900 },
});

export const failedResponse = (failure: Extract<AiResponse, { ok: false }>['failure'], detail = 'Test failure.'): AiResponse => ({
  ok: false,
  failure,
  detail,
  model: null,
  responseId: null,
  usage: { inputTokens: null, outputTokens: null },
});

type Step = AiResponse | ((request: AiRequest) => AiResponse | Promise<AiResponse>);

/** A provider that replays scripted responses and records every request it receives. */
export function scriptedProvider(...steps: Step[]): AiProvider & { requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return {
    name: 'openai',
    model: TEST_MODEL,
    requests,
    async investigate(request) {
      requests.push(request);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      if (!step) throw new Error('No scripted response');
      return typeof step === 'function' ? step(request) : step;
    },
  };
}

export const clone = <T>(value: T): T => structuredClone(value);

/** Valid analysis of the seeded RC-1044 case: provider RETURNED after UNCLAIMED. */
export function providerCaseOutput(): InvestigationOutput {
  return {
    known: [
      { id: 'K1', statement: 'The simulated provider record shows RETURNED.', basis: 'provider_record', evidenceIds: ['PRV1'], citedValues: [{ evidenceId: 'PRV1', field: 'status', value: 'RETURNED' }] },
      {
        id: 'K2',
        statement: 'The simulated provider record was last updated on 2026-10-19.',
        basis: 'provider_record',
        evidenceIds: ['PRV1'],
        citedValues: [{ evidenceId: 'PRV1', field: 'statusUpdatedAt', value: '2026-10-19' }],
      },
      { id: 'K3', statement: 'The provider status was last updated 21 days ago.', basis: 'derived', evidenceIds: ['DRV1'], citedValues: [{ evidenceId: 'DRV1', field: 'value', value: '21' }] },
      {
        id: 'K4',
        statement: 'Unclaimed payouts are returned after 30 days.',
        basis: 'reference_rule',
        evidenceIds: ['RUL4'],
        citedValues: [{ evidenceId: 'RUL4', field: 'text', value: 'Unclaimed payouts are returned after 30 days' }],
      },
    ],
    unknowns: [{ id: 'U1', kind: 'missing_information', question: 'Whether the receiver identifier is linked to a PayPal account.', evidenceIds: ['PRV1'] }],
    possibilities: [
      {
        id: 'P1',
        category: 'recipient_has_not_claimed',
        explanation: 'The payment may not have been claimed because no account was linked to the identifier.',
        supports: [
          { evidenceId: 'EVT1', field: 'newStatus', value: 'UNCLAIMED', reason: 'The simulated provider reported the payment as unclaimed first.' },
          { evidenceId: 'PRV1', field: 'status', value: 'RETURNED', reason: 'Unclaimed payouts are returned to the sender.' },
        ],
        weakens: [],
        wouldBeResolvedBy: ['U1'],
      },
    ],
    nextSteps: [
      {
        id: 'S1',
        type: 'request_information_from_programme_team',
        action: 'Ask the programme team to re-verify the receiver identifier.',
        relatesTo: ['U1'],
        informationNeeded: 'Whether the receiver identifier on file is current.',
      },
      { id: 'S2', type: 'propose_reissue', action: 'Once the identifier is re-verified, consider proposing a reissue for approval.', relatesTo: ['K1'], informationNeeded: null },
    ],
    conclusion: {
      summary: 'The simulated provider record shows RETURNED (PRV1). The records do not show why the payment was not claimed.',
      evidenceIds: ['PRV1', 'EVT2'],
      limitations: 'The records cannot show whether the receiver identifier is linked to a PayPal account.',
    },
  };
}

/** Valid analysis of the conflict scenario: provider SUCCESS, imported RETURNED. */
export function conflictCaseOutput(): InvestigationOutput {
  return {
    known: [
      { id: 'K1', statement: 'The simulated provider record shows SUCCESS.', basis: 'provider_record', evidenceIds: ['PRV1'], citedValues: [{ evidenceId: 'PRV1', field: 'status', value: 'SUCCESS' }] },
      {
        id: 'K2',
        statement: 'The current imported record shows RETURNED with a status date of 2026-11-08.',
        basis: 'imported_record',
        evidenceIds: ['OBS1'],
        citedValues: [
          { evidenceId: 'OBS1', field: 'status', value: 'RETURNED' },
          { evidenceId: 'OBS1', field: 'statusDate', value: '2026-11-08' },
        ],
      },
      {
        id: 'K3',
        statement: 'ReliefRelay recorded a provider status conflict finding for this payment.',
        basis: 'reconciliation_rule',
        evidenceIds: ['FND2'],
        citedValues: [{ evidenceId: 'FND2', field: 'code', value: 'provider_status_conflict' }],
      },
      {
        id: 'K4',
        statement: 'Provider records are authoritative for payment status.',
        basis: 'reference_rule',
        evidenceIds: ['RUL1'],
        citedValues: [{ evidenceId: 'RUL1', field: 'text', value: 'Provider records are authoritative for payment status' }],
      },
    ],
    unknowns: [
      {
        id: 'U1',
        kind: 'conflicting_records',
        question: 'Which record is correct: the simulated provider record showing SUCCESS or the imported record showing RETURNED?',
        evidenceIds: ['CON1', 'PRV1', 'OBS1'],
      },
      { id: 'U2', kind: 'missing_information', question: 'Whether the organisation’s export reflects an event the simulated provider record does not include.', evidenceIds: ['OBS1'] },
    ],
    possibilities: [
      {
        id: 'P1',
        category: 'data_entry_or_export_error',
        explanation: 'The imported record may contain an export or data entry error.',
        supports: [{ evidenceId: 'PRV1', field: 'status', value: 'SUCCESS', reason: 'The authoritative record shows a different status.' }],
        weakens: [],
        wouldBeResolvedBy: ['U1'],
      },
    ],
    nextSteps: [
      {
        id: 'S1',
        type: 'request_information_from_programme_team',
        action: 'Ask the programme team how the RETURNED status was entered in their export.',
        relatesTo: ['K2', 'U1'],
        informationNeeded: 'The source of the RETURNED status in the export dated 2026-11-08.',
      },
      { id: 'S2', type: 'record_conclusion_in_notes', action: 'Record which record is correct in the case notes once confirmed.', relatesTo: ['U1'], informationNeeded: null },
    ],
    conclusion: {
      summary: 'The simulated provider record and the imported record disagree about this payment (CON1). The provider record is treated as authoritative, but the records do not explain the difference.',
      evidenceIds: ['CON1', 'PRV1', 'OBS1'],
      limitations: 'This analysis cannot establish which record is correct or why they differ.',
    },
  };
}

/** Valid analysis of the imported-only scenario: imported FAILED, no provider record. */
export function importedCaseOutput(errorCode = 'RECEIVER_UNREGISTERED'): InvestigationOutput {
  return {
    known: [
      {
        id: 'K1',
        statement: `The current imported record shows FAILED with error code ${errorCode}.`,
        basis: 'imported_record',
        evidenceIds: ['OBS1'],
        citedValues: [
          { evidenceId: 'OBS1', field: 'status', value: 'FAILED' },
          { evidenceId: 'OBS1', field: 'errorCode', value: errorCode },
        ],
      },
      {
        id: 'K2',
        statement: 'The batch was imported from a CSV file and was never submitted through ReliefRelay.',
        basis: 'reliefrelay_record',
        evidenceIds: ['BATCH1'],
        citedValues: [{ evidenceId: 'BATCH1', field: 'batchOrigin', value: 'csv_import' }],
      },
    ],
    unknowns: [
      { id: 'U1', kind: 'missing_information', question: 'Whether a provider has any record of this payment.', evidenceIds: ['GAP1', 'PAY1'] },
      { id: 'U2', kind: 'cannot_be_established', question: 'Why the payment failed cannot be established from an imported record alone.', evidenceIds: ['OBS1'] },
    ],
    possibilities: [],
    nextSteps: [{ id: 'S1', type: 'check_provider_status', action: 'Check whether the payment was ever submitted to a provider.', relatesTo: ['U1'], informationNeeded: null }],
    conclusion: {
      summary: 'The imported record shows FAILED (OBS1), but there is no provider record for this payment (GAP1).',
      evidenceIds: ['OBS1', 'GAP1'],
      limitations: 'Without a provider record, this analysis cannot establish whether the payment was attempted or why it failed.',
    },
  };
}
