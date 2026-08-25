import type { DaemonStatus } from '../wizard/wizard.types';

const RESTART_COMMAND = 'jobbunny serve stop && jobbunny serve start';
const START_COMMAND = 'jobbunny serve start';

export type DaemonStatusTone = 'success' | 'attention' | 'destructive' | 'muted';

export interface DaemonStatusWord {
  word: string;
  tone: DaemonStatusTone;
  detail: string;
}

/** mockup.html:717's terse "Degraded — schema vN > daemon build vM" form,
 * read directly off the two structured fields the daemon status payload
 * carries (`schemaVersion`/`buildVersion`) rather than re-derived by regex
 * over `degradedReason`'s prose — the "kill the regex stage-guess" pattern
 * this repo already tore out once elsewhere. Falls back to the full reason
 * sentence when either field is null (a stale pidfile entry from before
 * these fields existed), so the degraded posture is never silently
 * unrendered. */
function degradedLabel(entry: {
  schemaVersion: number | null;
  buildVersion: number | null;
  degradedReason: string | null;
}): string {
  if (entry.schemaVersion != null && entry.buildVersion != null) {
    return `Degraded — schema v${entry.schemaVersion} > daemon build v${entry.buildVersion}`;
  }
  return `Degraded — ${entry.degradedReason}`;
}

/** Pure derivation of the daemon status word/tone/detail shown for a given
 * profile, extracted out of `ScheduleSection.tsx`'s inline conditional
 * (behaviour-preserving — see that file's history). Only covers the four
 * branches that are properties of an already-resolved `DaemonStatus`
 * payload: `degraded`, `stopped`, `stale`, and the healthy fallback.
 * `daemon.isLoading`/`daemon.isError` are `useQuery` states, not
 * `DaemonStatus` properties — callers handle those themselves before ever
 * calling this function. */
export function daemonStatusWord(
  daemon: DaemonStatus,
  profile: string,
): DaemonStatusWord {
  const entry = daemon.profiles.find((p) => p.profile === profile);
  const lastTickSeconds =
    daemon.lastTickAt != null
      ? Math.round((Date.now() - Date.parse(daemon.lastTickAt)) / 1000)
      : null;
  const lastTickSuffix =
    lastTickSeconds != null ? ` · last tick ${lastTickSeconds}s ago` : '';

  if (entry?.degraded) {
    return {
      word: degradedLabel(entry),
      tone: 'attention',
      detail: `Fix: ${RESTART_COMMAND}`,
    };
  }
  if (daemon.state === 'stopped') {
    return {
      word: 'Not running',
      tone: 'destructive',
      detail: `— start it: ${START_COMMAND}`,
    };
  }
  if (daemon.state === 'stale') {
    return { word: 'Wedged', tone: 'attention', detail: lastTickSuffix };
  }
  return { word: 'Running', tone: 'success', detail: lastTickSuffix };
}
