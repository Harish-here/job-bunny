/**
 * Read-side soft-error grouping over `run_events` warn/error rows
 * (R9, blueprint §5). No write-side instrumentation — this is a pure
 * function over rows the caller has already read from `RunStoreReader`.
 *
 * The grouping key is a PRAGMATIC bucketing over genuinely heterogeneous
 * `data_json` shapes, not a strict typed union: recon shows the
 * breaker-open warn carries `{ reopenAt, tripCount }`, per-URL warns carry
 * `{ lane, company, error }` roughly, and other events carry other shapes
 * entirely. There is no single schema to type against, so this derives a
 * best-effort key from `data.scope` (+ `data.company`/`data.lane` when
 * present) and falls back to an `'unknown'` bucket rather than throwing.
 */
import type { RunEventRow } from '../../../ports/run_store.ts';

export interface SoftErrorGroup {
  key: string; // e.g. "source.linkedin" (scope) or "source.linkedin·acme corp" (scope+company)
  label: string; // human label for the disclosure row, e.g. "source: empty job shell (linkedin)"
  count: number;
  sample: string; // one representative event msg
}

export interface SoftErrorSummary {
  total: number; // warn+error count
  groups: SoftErrorGroup[]; // sorted by count desc
  /** True when any of the three throttle-breaker warn messages appears
   * anywhere in `events` — computed by scanning every raw event's `msg`,
   * NEVER a group's `sample` (fix-round finding #3): `pipeline/runner/
   * run.ts`'s `withScope(logger, stage.name)` means the breaker-open warn
   * (`adapters/lanes/linkedin/lane.ts`) carries `data.scope === 'farm'`,
   * the SAME key every other farm-stage warn buckets under — a group's
   * `sample` is whichever event landed in that key FIRST, which is
   * frequently not the breaker warn at all. See `runs_read.ts`'s own
   * `fetchRunHealth` (`adapters/db/sqlite/board`) for the read-side twin
   * of this same three-message list, duplicated rather than imported
   * across the adapters/app layer boundary. */
  breakerOpen: boolean;
  /** Whether a run-yield cap's warn message appears anywhere in `events`,
   * per cap, independently — same scanning discipline as `breakerOpen`
   * (every raw event's `msg`, never a group's `sample`). `maxProbesPerRun`
   * is deliberately absent: no signal exists yet to detect it from run
   * events. */
  capsHit: { maxNewPerLane: boolean; maxCardsPerUrl: boolean };
}

const UNKNOWN_KEY = 'unknown';

/** Exact substrings of the three throttle-breaker warn messages a run can
 * log: the open-skip warn (`adapters/lanes/linkedin/lane.ts`), the trip
 * warn (`fire/loop/cards.ts`), and the half-open-probe re-open warn
 * (`fire/probe.ts`). */
const BREAKER_MESSAGE_SUBSTRINGS = [
  'throttle breaker is open',
  'opening the breaker',
  'breaker re-opened',
];

function hasBreakerMessage(events: RunEventRow[]): boolean {
  return events.some((event) =>
    BREAKER_MESSAGE_SUBSTRINGS.some((substring) => event.msg.includes(substring)),
  );
}

/** Exact substrings of the two run-yield cap warn messages a run can log:
 * the `maxNewPerLane` cap (`pipeline/stages/source.ts`) and the
 * `maxCardsPerUrl` cap (`adapters/lanes/linkedin/fire/loop/cards.ts`). */
const CAP_MESSAGE_SUBSTRINGS = [
  'source: maxNewPerLane cap hit — dropping remainder',
  'linkedin lane: maxCardsPerUrl cap hit — dropping remainder for this url',
] as const;

function capsHit(events: RunEventRow[]): {
  maxNewPerLane: boolean;
  maxCardsPerUrl: boolean;
} {
  const [maxNewPerLaneSubstring, maxCardsPerUrlSubstring] = CAP_MESSAGE_SUBSTRINGS;
  return {
    maxNewPerLane: events.some((event) => event.msg.includes(maxNewPerLaneSubstring)),
    maxCardsPerUrl: events.some((event) => event.msg.includes(maxCardsPerUrlSubstring)),
  };
}

function keyOf(data: Record<string, unknown> | undefined): {
  key: string;
  scope: string | undefined;
  detail: string | undefined;
} {
  const scope = data && typeof data.scope === 'string' ? data.scope : undefined;
  if (!scope) return { key: UNKNOWN_KEY, scope: undefined, detail: undefined };

  const company = data && typeof data.company === 'string' ? data.company : undefined;
  const lane = data && typeof data.lane === 'string' ? data.lane : undefined;
  const detail = company ?? lane;

  return { key: detail ? `${scope}·${detail}` : scope, scope, detail };
}

function labelOf(scope: string | undefined, detail: string | undefined): string {
  if (!scope) return 'unknown: uncategorized soft error';
  return `${scope}: ${detail ?? 'unknown'}`;
}

/**
 * Groups already-filtered warn/error `RunEventRow`s by a best-effort key
 * derived from `data.scope` (+ `data.company`/`data.lane` when present).
 * Does NOT filter by `level` itself — the caller (Task 4/B7's route) is
 * responsible for passing only warn/error rows.
 */
export function groupSoftErrors(events: RunEventRow[]): SoftErrorSummary {
  const byKey = new Map<
    string,
    {
      key: string;
      scope: string | undefined;
      detail: string | undefined;
      count: number;
      sample: string;
    }
  >();

  for (const event of events) {
    const { key, scope, detail } = keyOf(event.data);
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byKey.set(key, { key, scope, detail, count: 1, sample: event.msg });
    }
  }

  const groups: SoftErrorGroup[] = Array.from(byKey.values())
    .map((g) => ({
      key: g.key,
      label: labelOf(g.scope, g.detail),
      count: g.count,
      sample: g.sample,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    total: events.length,
    groups,
    breakerOpen: hasBreakerMessage(events),
    capsHit: capsHit(events),
  };
}
