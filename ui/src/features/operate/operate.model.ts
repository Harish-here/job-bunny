import type { DaemonState } from '../wizard/wizard.types';

// Top billing (frozen): fires only when the daemon is NOT running, the
// schedule is enabled, and at least one time is set. `times[0]` is
// `string | undefined` under noUncheckedIndexedAccess — the explicit check
// is required, not an oversight. Reused by DaemonCard.tsx's degraded-state
// check (step 30).
export function scheduleWarning(input: {
  daemonState: DaemonState;
  scheduleEnabled: boolean;
  times: string[];
}): { firstTime: string } | null {
  if (input.daemonState === 'running') return null;
  if (!input.scheduleEnabled) return null;
  const firstTime = input.times[0];
  if (firstTime === undefined) return null;
  return { firstTime };
}
