import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  ApproveProposalRequest,
  AuditListResponse,
  ConnectionCheckResult,
  CreateProposalRequest,
  DecideProposalRequest,
  DemoIdentitiesResponse,
  JudgeScenarioOutcome,
  JudgeScenarioResponse,
  JudgeScenariosResponse,
  PaymentActionsResponse,
  PayPalIntegrationResponse,
  ProposalListResponse,
  ProposalResponse,
  ReconcileRequest,
  StatusCheckResponse,
} from '@shared/api/contracts';
import type { ProposalStatus } from '@shared/domain/payouts';
import { apiGet, apiSend } from '../services/apiClient';

const IN_FLIGHT = new Set(['PENDING', 'PROCESSING']);

/** True while a sent recovery payout has no final provider status yet, so its status is still being polled. */
function recoveryInFlight(actions: PaymentActionsResponse | undefined): boolean {
  if (!actions) return false;
  const sending = actions.submissions.some((s) => s.state === 'prepared' || s.state === 'sending');
  return sending || actions.recoveries.some((r) => !r.provider || IN_FLIGHT.has(r.provider.status));
}

export function usePaymentActions(caseId: string) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['payment-actions', caseId],
    queryFn: ({ signal }) => apiGet<PaymentActionsResponse>(`/cases/${caseId}/payment-actions`, signal),
    refetchInterval: (q) => (recoveryInFlight(q.state.data) ? 8_000 : false),
  });
  const statuses = query.data?.recoveries.map((r) => r.provider?.status ?? 'none').join(',');
  const previous = useRef(statuses);
  useEffect(() => {
    if (previous.current !== undefined && statuses !== previous.current) void client.invalidateQueries({ queryKey: ['case', caseId] });
    previous.current = statuses;
  }, [statuses, caseId, client]);
  return query;
}

export function useProposals(status: ProposalStatus | 'all') {
  return useQuery({
    queryKey: ['proposals', status],
    queryFn: ({ signal }) => apiGet<ProposalListResponse>(`/proposals${status === 'all' ? '' : `?status=${status}`}`, signal),
    placeholderData: (previous) => previous,
  });
}

function proposalInFlight(response: ProposalResponse | undefined): boolean {
  const submission = response?.proposal.submission;
  if (!submission) return false;
  if (submission.state === 'prepared' || submission.state === 'sending') return true;
  return (
    submission.state === 'accepted' &&
    response.proposal.attempts.some((a) => a.kind === 'recovery' && (!a.provider || IN_FLIGHT.has(a.provider.status)))
  );
}

export function useProposal(id: string) {
  return useQuery({
    queryKey: ['proposal', id],
    queryFn: ({ signal }) => apiGet<ProposalResponse>(`/proposals/${id}`, signal),
    refetchInterval: (q) => (proposalInFlight(q.state.data) ? 8_000 : false),
  });
}

/** Everything that can show a payment action's state. */
function invalidatePayments(client: QueryClient, caseId?: string) {
  for (const key of [['proposals'], ['proposal'], ['cases'], ['overview'], ['audit'], ['paypal-integration']]) void client.invalidateQueries({ queryKey: key });
  if (caseId) {
    void client.invalidateQueries({ queryKey: ['payment-actions', caseId] });
    void client.invalidateQueries({ queryKey: ['case', caseId] });
  } else {
    void client.invalidateQueries({ queryKey: ['payment-actions'] });
    void client.invalidateQueries({ queryKey: ['case'] });
  }
}

function useCaseActionMutation<V>(caseId: string, send: (variables: V) => Promise<PaymentActionsResponse>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (actions) => client.setQueryData(['payment-actions', caseId], actions),
    onSettled: () => invalidatePayments(client, caseId),
  });
}

export function useCheckStatus(caseId: string) {
  return useCaseActionMutation(caseId, async (itemId: string) => (await apiSend<StatusCheckResponse>('POST', `/cases/${caseId}/payment-actions/status-checks`, { itemId })).actions);
}

export function useCreateProposal(caseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProposalRequest) => apiSend<ProposalResponse>('POST', `/cases/${caseId}/proposals`, body),
    onSettled: () => invalidatePayments(client, caseId),
  });
}

export function useRetrySubmission(caseId: string) {
  return useCaseActionMutation(caseId, (submissionId: string) => apiSend<PaymentActionsResponse>('POST', `/submissions/${submissionId}/retry`));
}

export function useReconcileSubmission(caseId: string) {
  return useCaseActionMutation(caseId, ({ submissionId, ...body }: ReconcileRequest & { submissionId: string }) =>
    apiSend<PaymentActionsResponse>('POST', `/submissions/${submissionId}/reconcile`, body),
  );
}

export function useRecheckCancellation(caseId: string) {
  return useCaseActionMutation(caseId, (cancellationId: string) => apiSend<PaymentActionsResponse>('POST', `/cancellations/${cancellationId}/recheck`));
}

export function useResolveDiscrepancy(caseId: string) {
  return useCaseActionMutation(caseId, ({ discrepancyId, note }: { discrepancyId: string; note: string }) =>
    apiSend<PaymentActionsResponse>('POST', `/discrepancies/${discrepancyId}/resolve`, { note }),
  );
}

type Decision = { kind: 'approve'; body: ApproveProposalRequest } | { kind: 'reject' | 'withdraw'; body: DecideProposalRequest };

export function useDecideProposal(proposalId: string, caseId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, body }: Decision) => apiSend<ProposalResponse>('POST', `/proposals/${proposalId}/${kind}`, body),
    onSuccess: (response) => client.setQueryData(['proposal', proposalId], response),
    onSettled: () => invalidatePayments(client, caseId),
  });
}

export function usePayPalIntegration() {
  return useQuery({
    queryKey: ['paypal-integration'],
    queryFn: ({ signal }) => apiGet<PayPalIntegrationResponse>('/integrations/paypal', signal),
  });
}

export function useConnectionCheck() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend<ConnectionCheckResult>('POST', '/integrations/paypal/connection-check'),
    onSettled: () => void client.invalidateQueries({ queryKey: ['paypal-integration'] }),
  });
}

export function useAuditHistory(query: string) {
  return useQuery({
    queryKey: ['audit', query],
    queryFn: ({ signal }) => apiGet<AuditListResponse>(`/audit?${query}`, signal),
    placeholderData: (previous) => previous,
  });
}

export function useJudgeScenarios(enabled: boolean) {
  return useQuery({
    queryKey: ['judge-scenarios'],
    queryFn: ({ signal }) => apiGet<JudgeScenariosResponse>('/judge-demo/scenarios', signal),
    enabled,
  });
}

export function useCreateJudgeScenario() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (outcome: JudgeScenarioOutcome) => apiSend<JudgeScenarioResponse>('POST', '/judge-demo/scenarios', { outcome }),
    onSettled: () => {
      for (const key of [['judge-scenarios'], ['cases'], ['overview'], ['audit']]) void client.invalidateQueries({ queryKey: key });
    },
  });
}

export function useDemoIdentities(enabled: boolean) {
  return useQuery({
    queryKey: ['demo-identities'],
    queryFn: ({ signal }) => apiGet<DemoIdentitiesResponse>('/demo/identities', signal),
    enabled,
  });
}

export function useSwitchDemoIdentity() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => apiSend<DemoIdentitiesResponse>('POST', '/demo/identity', { userId }),
    onSuccess: () => void client.invalidateQueries(),
  });
}
