import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CommitImportResponse,
  ImportDetail,
  ImportListResponse,
  ImportRowsResponse,
  UploadImportResponse,
} from '@shared/api/contracts';
import type { ColumnMapping, RowIssueCode, RowOutcome } from '@shared/domain/imports';
import { apiGet, apiSend, apiUploadCsv } from '../services/apiClient';

export function useImportList() {
  return useQuery({
    queryKey: ['imports'],
    queryFn: ({ signal }) => apiGet<ImportListResponse>('/imports', signal),
  });
}

export function useImport(id: string) {
  return useQuery({
    queryKey: ['imports', id],
    queryFn: ({ signal }) => apiGet<ImportDetail>(`/imports/${id}`, signal),
  });
}

export interface RowFilter {
  outcome?: RowOutcome;
  issue?: RowIssueCode;
  page: number;
}

export function useImportRows(id: string, version: number, filter: RowFilter) {
  const params = new URLSearchParams({ page: String(filter.page), pageSize: '25' });
  if (filter.outcome) params.set('outcome', filter.outcome);
  if (filter.issue) params.set('issue', filter.issue);
  return useQuery({
    queryKey: ['imports', id, 'rows', version, filter],
    queryFn: ({ signal }) => apiGet<ImportRowsResponse>(`/imports/${id}/rows?${params.toString()}`, signal),
    enabled: version > 0,
    placeholderData: (previous) => previous,
  });
}

/** Committing changes payments, cases and the overview, so every cached view is refreshed. */
function useInvalidateAll() {
  const client = useQueryClient();
  return () => client.invalidateQueries();
}

export function useUploadImport() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (file: File) => apiUploadCsv<UploadImportResponse>('/imports', file),
    onSuccess: () => invalidate(),
  });
}

export function useApplyMapping(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (mapping: ColumnMapping) => apiSend<ImportDetail>('PUT', `/imports/${id}/mapping`, { mapping }),
    onSuccess: (detail) => {
      client.setQueryData(['imports', id], detail);
      void client.invalidateQueries({ queryKey: ['imports'] });
    },
  });
}

export function useCommitImport(id: string) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (validationVersion: number) => apiSend<CommitImportResponse>('POST', `/imports/${id}/commit`, { validationVersion, confirm: true }),
    onSettled: () => invalidate(),
  });
}

export function useDiscardImport(id: string) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: () => apiSend<ImportDetail>('POST', `/imports/${id}/discard`),
    onSettled: () => invalidate(),
  });
}
