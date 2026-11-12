import { useQuery } from '@tanstack/react-query';
import type { SessionResponse } from '@shared/api/contracts';
import { apiGet } from '../services/apiClient';

export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: ({ signal }) => apiGet<SessionResponse>('/session', signal),
    staleTime: 5 * 60 * 1000,
  });
}
