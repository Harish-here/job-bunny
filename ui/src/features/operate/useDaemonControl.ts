import { useMutation, useQueryClient } from '@tanstack/react-query';
import { wizardKeys } from '../wizard/wizard.queries';
import { setAutostart, startDaemon, stopDaemon } from './operate.api';

/**
 * Three `useMutation` wrappers over operate.api.ts's daemon-control
 * functions. No optimistic cache writes — mirrors useConfigMutation.ts's
 * "no optimistic update, the result IS the state" posture. Each
 * `onSuccess` invalidates `wizardKeys.daemon()`, the SAME cache entry
 * operate.queries.ts's `doctorQuery` sibling and wizard's `daemonQuery`
 * both key off — DaemonCard and ScheduleSection's bridge line must
 * invalidate off this one key, or they could show different daemon
 * states simultaneously.
 *
 * `StopDaemonOutcome`/`StartDaemonOutcome`/`AutostartOutcome` cover only
 * expected server outcomes. A real autostart conflict (darwin legacy
 * plist) is NOT a fourth outcome variant — the server throws
 * `HttpError(409, 'autostart_conflict', ...)`, which `lib/api/client.ts`
 * surfaces as a rejected promise carrying `ApiError`. None of these three
 * mutations catch that rejection: it must propagate so React Query
 * populates `isError`/`error` for the component to render against.
 */
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
