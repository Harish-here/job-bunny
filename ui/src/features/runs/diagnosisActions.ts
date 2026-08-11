import type { RunEventRow } from '../../lib/api/types';
import type { Route } from '../../lib/router';

/**
 * A diagnosis's call-to-action, carrying a real target rather than an inert
 * label. Extracted from `runDiagnosis.ts` so that module can stay under its
 * size cap while this one owns the shared evidence readers the action
 * table needs (breaker retry timestamps, countdown formatting).
 */
export type DiagnosisAction =
  | { kind: 'run'; label: string; disabled?: boolean; retryAt?: string }
  | { kind: 'navigate'; label: string; route: Route }
  | { kind: 'copy'; label: string; command: string }
  | { kind: 'reveal'; label: string; target: 'events' };

export function runAction(
  label: string,
  opts?: { disabled?: boolean; retryAt?: string },
): DiagnosisAction {
  return { kind: 'run', label, ...opts };
}

export function navigateAction(label: string, route: Route): DiagnosisAction {
  return { kind: 'navigate', label, route };
}

export function copyAction(label: string, command: string): DiagnosisAction {
  return { kind: 'copy', label, command };
}

export function revealAction(
  label: string,
  target: 'events' = 'events',
): DiagnosisAction {
  return { kind: 'reveal', label, target };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Exact substring of the LinkedIn lane's open-breaker warn
 * (`src/adapters/lanes/linkedin/lane.ts:154-157`), which is the only one of
 * the three breaker warn messages that carries `data.reopenAt`. */
const BREAKER_OPEN_SUBSTRING = 'throttle breaker is open';

/**
 * Scans `events` for the LinkedIn throttle-breaker's open-skip warn and
 * returns its `data.reopenAt` ISO timestamp — the LAST such event wins if
 * more than one is present. Returns `undefined` when no matching event
 * carries a `reopenAt` string; callers must never invent or compute a
 * fallback timestamp from this.
 */
export function readBreakerRetryAt(
  events: RunEventRow[] | undefined,
): string | undefined {
  if (!events) return undefined;
  let retryAt: string | undefined;
  for (const event of events) {
    if (!event.msg.includes(BREAKER_OPEN_SUBSTRING)) continue;
    const data = isRecord(event.data) ? event.data : undefined;
    const reopenAt = data?.reopenAt;
    if (typeof reopenAt === 'string') retryAt = reopenAt;
  }
  return retryAt;
}

/**
 * Formats the mockup's countdown chip text, e.g. `'Retry in 34m'`. Returns
 * `null` (no chip) when `retryAt` is unparseable or already in the past;
 * sub-minute remainders round to `'Retry in <1m'` rather than `'0m'`.
 * Minutes only, no hours unit — the mockup's own shape.
 */
export function formatRetryIn(retryAt: string, now: number): string | null {
  const target = Date.parse(retryAt);
  if (Number.isNaN(target)) return null;
  const remaining = target - now;
  if (remaining <= 0) return null;
  if (remaining < 60_000) return 'Retry in <1m';
  return `Retry in ${Math.round(remaining / 60_000)}m`;
}
