import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CaseDetail, CaseListResponse } from '@shared/api/contracts';
import { apiGet, apiSend } from '../services/apiClient';

export function useCaseList(query: string) {
  return useQuery({
    queryKey: ['cases', query],
    queryFn: ({ signal }) => apiGet<CaseListResponse>(`/cases?${query}`, signal),
    placeholderData: (previous) => previous,
  });
}

export function useCase(id: string) {
  return useQuery({
    queryKey: ['case', id],
    queryFn: ({ signal }) => apiGet<CaseDetail>(`/cases/${id}`, signal),
  });
}

function useCaseMutation<V>(id: string, send: (variables: V) => Promise<CaseDetail>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (detail) => client.setQueryData(['case', id], detail),
    onError: () => void client.invalidateQueries({ queryKey: ['case', id] }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['cases'] });
      void client.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

export function useAssignCase(id: string) {
  return useCaseMutation(id, (expectedVersion: number) => apiSend<CaseDetail>('POST', `/cases/${id}/assign`, { expectedVersion }));
}

export function useAddNote(id: string) {
  return useCaseMutation(id, (body: string) => apiSend<CaseDetail>('POST', `/cases/${id}/notes`, { body }));
}
