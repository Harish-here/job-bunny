/**
 * `RunDetail.result`/`.failure` are opaque `unknown` at the port boundary
 * (`ports/run_store.ts`: "shapes owned by their writers ... ports-only-core
 * forbids importing [RunResultSchema] here"). The UI is on the other side
 * of that same boundary — it narrows defensively rather than importing the
 * zod schema, so a malformed/absent blob degrades to "no funnel to show"
 * instead of a render crash.
 */
export interface FunnelStage {
  name: string;
  jobsIn: number;
  jobsOut: number;
  dropsByRule: Record<string, number>;
  elapsedMs: number;
  attempts: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFunnelStage(value: unknown): value is FunnelStage {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.jobsIn === 'number' &&
    typeof value.jobsOut === 'number' &&
    isRecord(value.dropsByRule) &&
    typeof value.elapsedMs === 'number' &&
    typeof value.attempts === 'number'
  );
}

/** Returns the per-stage funnel from `RunDetail.result`, or `null` when the
 * blob is absent/malformed (e.g. a run that crashed before writing one). */
export function getFunnelStages(result: unknown): FunnelStage[] | null {
  if (!isRecord(result) || !Array.isArray(result.stages)) return null;
  const stages = result.stages.filter(isFunnelStage);
  return stages.length === result.stages.length ? stages : null;
}

/** Returns `RunDetail.failure.stage`, or `null` when the blob is
 * absent/malformed — mirrors `RunFailure.stage` (ports/run_store.ts). */
export function getFailedStage(failure: unknown): string | null {
  if (!isRecord(failure)) return null;
  return typeof failure.stage === 'string' ? failure.stage : null;
}

/** Returns `RunDetail.failure.error`, or `null` when the blob is
 * absent/malformed. */
export function getFailureError(failure: unknown): string | null {
  if (!isRecord(failure)) return null;
  return typeof failure.error === 'string' ? failure.error : null;
}

/** Returns the last funnel stage's `jobsOut` — the only "how many new
 * matches" signal available today (`RunSummary` carries no job count).
 * `0` when the funnel blob is absent, empty, or malformed. */
export function newMatchCount(result: unknown): number {
  const stages = getFunnelStages(result);
  if (!stages || stages.length === 0) return 0;
  const last = stages[stages.length - 1];
  return last ? last.jobsOut : 0;
}

/** Stages excluded from retention arithmetic: `farm` has no meaningful
 * in→out yield (it's additive, see CLAUDE.md's "Known limitations"), and
 * `reconcile` is a state-sync stage with no meaningful in→out yield either
 * (per ux-notes.md §5 / B17's `n/a · state-sync only` treatment). */
const RETENTION_EXCLUDED_STAGES = new Set(['reconcile', 'farm']);

/** Returns the single largest drop across every stage's `dropsByRule`, or
 * `null` when `stages` is empty or no stage recorded any drop. Ties break to
 * the first-encountered stage/rule in array order (stable iteration, `>` not
 * `>=` when comparing to the running max). */
export function getBiggestDrop(
  stages: FunnelStage[],
): { stage: string; rule: string; count: number } | null {
  let biggest: { stage: string; rule: string; count: number } | null = null;
  for (const stage of stages) {
    for (const [rule, count] of Object.entries(stage.dropsByRule)) {
      if (!biggest || count > biggest.count) {
        biggest = { stage: stage.name, rule, count };
      }
    }
  }
  return biggest;
}

/** Aggregate retention over a funnel, after excluding `reconcile` and `farm`
 * by name (see `RETENTION_EXCLUDED_STAGES`) — both are state-sync/additive
 * stages with no meaningful in→out yield, so including them would skew the
 * "how many jobs survived the funnel" summary. `startCount` is the first
 * remaining stage's `jobsIn`; `endCount` is the last remaining stage's
 * `jobsOut`; `retainedPct` is `endCount / startCount * 100`, `0` when there
 * are no remaining stages or `startCount` is `0`. */
export function computeRetention(stages: FunnelStage[]): {
  startCount: number;
  endCount: number;
  retainedPct: number;
} {
  const filtered = stages.filter((stage) => !RETENTION_EXCLUDED_STAGES.has(stage.name));
  const first = filtered[0];
  const last = filtered[filtered.length - 1];
  const startCount = first ? first.jobsIn : 0;
  const endCount = last ? last.jobsOut : 0;
  const retainedPct = startCount === 0 ? 0 : (endCount / startCount) * 100;
  return { startCount, endCount, retainedPct };
}
