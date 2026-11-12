import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InvestigationDetail, InvestigationListResponse } from '@shared/api/contracts';
import { apiGet, apiSend } from '../services/apiClient';

export function useInvestigations(caseId: string) {
  return useQuery({
    queryKey: ['investigations', caseId],
    queryFn: ({ signal }) => apiGet<InvestigationListResponse>(`/cases/${caseId}/investigations`, signal),
  });
}

export function useInvestigation(caseId: string, investigationId: string | null) {
  return useQuery({
    queryKey: ['investigation', caseId, investigationId],
    queryFn: ({ signal }) => apiGet<InvestigationDetail>(`/cases/${caseId}/investigations/${investigationId}`, signal),
    enabled: investigationId !== null,
  });
}

export function useRunInvestigation(caseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (caseVersion: number) => apiSend<InvestigationDetail>('POST', `/cases/${caseId}/investigations`, { caseVersion }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['investigations', caseId] });
      void client.invalidateQueries({ queryKey: ['case', caseId] });
    },
  });
}
