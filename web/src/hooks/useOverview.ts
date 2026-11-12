import { useQuery } from '@tanstack/react-query';
import type { OverviewResponse } from '@shared/api/contracts';
import { apiGet } from '../services/apiClient';

export function useOverview() {
  return useQuery({
    queryKey: ['overview'],
    queryFn: ({ signal }) => apiGet<OverviewResponse>('/overview', signal),
    refetchInterval: 60_000,
  });
}
