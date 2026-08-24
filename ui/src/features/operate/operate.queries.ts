import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { wizardKeys } from '../wizard/wizard.queries';
import { getDoctorReport, putSkipNext } from './operate.api';

export const operateKeys = {
  doctor: (p: string) => [p, 'doctor'] as const,
};

// Doctor is a live probe, not a document — no staleTime override and no
// refetchInterval; a manual refresh (page revisit, or task 6's
// post-save invalidation) is what refreshes it.
export const doctorQuery = (p: string) =>
  queryOptions({
    queryKey: operateKeys.doctor(p),
    queryFn: () => getDoctorReport(p),
    enabled: p !== '',
  });

// The stop/start/autostart daemon-control mutations live in
// ./useDaemonControl.ts, not here — mirrors the codebase-wide convention
// of keeping `useMutation` wrappers in their own `use*.ts` file, separate
// from the `queryOptions` this module holds (see useConfigMutation.ts).
// They still reuse wizardKeys.daemon() — the SAME cache entry wizard's
// daemonQuery reads — so DaemonCard and ScheduleSection's bridge line
// never show different daemon states simultaneously.

export function usePutSkipNext(profile: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skipNext: boolean) => putSkipNext(profile, skipNext),
    onSuccess: () => qc.invalidateQueries({ queryKey: wizardKeys.daemon() }),
  });
}
