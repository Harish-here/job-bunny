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
    isRecord(value.dropsByRule)
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
