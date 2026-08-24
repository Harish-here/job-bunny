import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { wizardKeys } from '../wizard/wizard.queries';
import {
  getDoctorReport,
  putSkipNext,
  setAutostart,
  startDaemon,
  stopDaemon,
} from './operate.api';

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

// Reuses wizardKeys.daemon() — the SAME cache entry wizard's daemonQuery
// reads. DaemonCard (a later brief) and ScheduleSection's bridge line both
// invalidate off this one key; introducing a second daemon key here would
// let the two surfaces show different daemon states simultaneously.
export function useStopDaemon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: stopDaemon,
    onSuccess: () => qc.invalidateQueries({ queryKey: wizardKeys.daemon() }),
  });
}

export function useStartDaemon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: startDaemon,
    onSuccess: () => qc.invalidateQueries({ queryKey: wizardKeys.daemon() }),
  });
}

export function useSetAutostart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => setAutostart(enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: wizardKeys.daemon() }),
  });
}

export function usePutSkipNext(profile: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skipNext: boolean) => putSkipNext(profile, skipNext),
    onSuccess: () => qc.invalidateQueries({ queryKey: wizardKeys.daemon() }),
  });
}
