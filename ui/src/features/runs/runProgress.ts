import type { RunEventRow, RunSummary } from '../../lib/api/types';

/** The frozen 10-stage pipeline order (CLAUDE.md, "Pipeline architecture"). */
export const STAGE_ORDER = [
  'reconcile',
  'farm',
  'source',
  'compress',
  'structure',
  'assemble',
  'filter',
  'dedup',
  'rank',
  'sync',
] as const;

const STAGE_PREFIX = /^([a-z]+):/;

/**
 * `run_events` rows carry no stage column — stages log their own free-text
 * `msg`, e.g. "structure: starting". This scans every event's `msg` for a
 * leading `<word>:` prefix, keeps only prefixes present in STAGE_ORDER, and
 * takes the LAST such match in event order (not the highest stage index
 * seen — see this task's brief Rationale for why "last, not max" is the
 * honest reading here). Returns null when no event matches, which callers
 * render as "starting…" rather than fabricating stage 1.
 */
export function parseStageProgress(
  events: RunEventRow[],
): { stage: string; index: number; total: number } | null {
  let found: string | null = null;
  for (const event of events) {
    const word = STAGE_PREFIX.exec(event.msg)?.[1];
    if (word !== undefined && (STAGE_ORDER as readonly string[]).includes(word)) {
      found = word;
    }
  }
  if (found === null) return null;
  const index = STAGE_ORDER.indexOf(found as (typeof STAGE_ORDER)[number]) + 1;
  return { stage: found, index, total: STAGE_ORDER.length };
}

export const RUN_HEARTBEAT_STALE_MS = 10 * 60 * 1000;

/** unknown when heartbeatAt is null or unparseable; stale when older than
 * RUN_HEARTBEAT_STALE_MS; fresh (inclusive of the boundary) otherwise. */
export function heartbeatFreshness(
  run: RunSummary,
  now: number,
): 'fresh' | 'stale' | 'unknown' {
  if (run.heartbeatAt === null) return 'unknown';
  const heartbeatAt = Date.parse(run.heartbeatAt);
  if (Number.isNaN(heartbeatAt)) return 'unknown';
  return now - heartbeatAt > RUN_HEARTBEAT_STALE_MS ? 'stale' : 'fresh';
}
