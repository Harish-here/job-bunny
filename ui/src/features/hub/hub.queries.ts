import { queryOptions } from '@tanstack/react-query';
import { getDoctorReport } from './hub.api';

export const hubKeys = {
  doctor: (p: string) => [p, 'doctor'] as const,
};

// Doctor is a live probe, not a document — no staleTime override and no
// refetchInterval; a manual refresh (page revisit, or task 6's
// post-save invalidation) is what refreshes it.
export const doctorQuery = (p: string) =>
  queryOptions({
    queryKey: hubKeys.doctor(p),
    queryFn: () => getDoctorReport(p),
    enabled: p !== '',
  });
