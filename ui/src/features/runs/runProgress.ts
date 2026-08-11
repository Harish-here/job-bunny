import type { RunProgress, RunSummary } from '../../lib/api/types';

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

/** Thin accessor over `run.progress` (persist-to-db R3) — the backend now
 * writes stage progress directly on the run row on every stage transition,
 * so there is no more need to re-derive it by scanning `run_events` for a
 * `<stage>:` message prefix (the old, guessy `parseStageProgress`). */
export function stageProgressFrom(run: RunSummary): RunProgress | null {
  return run.progress;
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
