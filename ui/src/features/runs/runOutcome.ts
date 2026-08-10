import type { RunDetail, RunSummary, SoftErrorSummary } from '../../lib/api/types';
import { getFailedStage, getFailureError, getFunnelStages } from './runResult';

/**
 * The seven-way outcome vocabulary (ux-notes.md §1 — "resolving concern
 * (a)"). Two states, `'failed'` and `'crashed'`, both cover a broken run;
 * the rest exist to stop a zero-yield run and a healthy zero-yield run from
 * rendering identically ("Calm is earned, not defaulted").
 */
export type OutcomeKind =
  | 'produced'
  | 'empty'
  | 'degraded'
  | 'failed'
  | 'crashed'
  | 'running'
  | 'unrecorded';

/** Total stage count in the frozen 10-stage pipeline
 * (`reconcile → farm → source → compress → structure → assemble → filter →
 * dedup → rank → sync`, CLAUDE.md "Pipeline architecture"). */
const TOTAL_PIPELINE_STAGES = 10;

/**
 * `SoftErrorSummary` carries only a raw `total` warn/error count, not a rate
 * against any denominator (no total-attempt/total-job count is available at
 * this call site to divide by) — so despite the name this reads as an
 * absolute-count threshold. Neither plan.md nor ux-notes.md names a number,
 * so this is this brief's own judgment call (task-10-brief.md step 1): a
 * single stray SoftError (one bad URL/company) shouldn't cost a zero-yield
 * run its calm treatment, but by the time a run has logged this many the
 * design's own "calm is earned, not defaulted" principle says withhold it —
 * so the threshold is picked deliberately low, biased toward 'degraded' over
 * false calm. Exported so component tests/the advisor can reference or
 * override the exact value.
 */
export const SOFT_ERROR_RATE_THRESHOLD = 3;

/** Substring of the breaker-open warn's exact message
 * (`adapters/lanes/linkedin/lane.ts`: "linkedin lane: throttle breaker is
 * open — skipping this fire without launching a browser"). The event's
 * `data` shape (`{ reopenAt, tripCount }`) has no `scope` field, so
 * `groupSoftErrors` (app/features/runs/soft_errors.ts) buckets it into the
 * generic `'unknown'` group rather than a dedicated key — the only way to
 * recognize it from a `SoftErrorSummary` is by matching a group's `sample`
 * text against this substring. */
const BREAKER_OPEN_SAMPLE_SUBSTRING = 'throttle breaker is open';

function isRunDetail(run: RunSummary | RunDetail): run is RunDetail {
  return 'result' in run;
}

/** True only for the exact A6 real-DB-row shape: `status === 'crashed'` AND
 * both the `result` and `failure` blobs are literally `null` (not merely
 * malformed/unparseable — a crashed run that DID manage to write one of the
 * two blobs is `'crashed'`, not `'unrecorded'`). Only decidable when `run`
 * carries `result`/`failure` at all, i.e. a `RunDetail` — a bare
 * `RunSummary` has no such fields to inspect, so it can never classify as
 * `'unrecorded'` and falls through to `'crashed'` instead (documented on
 * `classifyOutcome` below). */
function isUnrecorded(run: RunSummary | RunDetail): boolean {
  return (
    run.status === 'crashed' &&
    isRunDetail(run) &&
    run.result === null &&
    run.failure === null
  );
}

function hasBreakerOpenWarn(softErrors: SoftErrorSummary | undefined): boolean {
  if (!softErrors) return false;
  return softErrors.groups.some((group) =>
    group.sample.includes(BREAKER_OPEN_SAMPLE_SUBSTRING),
  );
}

function hasAllStages(result: unknown): boolean {
  const stages = getFunnelStages(result);
  return stages !== null && stages.length === TOTAL_PIPELINE_STAGES;
}

function hasNoFailureRecord(failure: unknown): boolean {
  return getFailedStage(failure) === null && getFailureError(failure) === null;
}

function softErrorRateUnderThreshold(softErrors: SoftErrorSummary | undefined): boolean {
  return (softErrors?.total ?? 0) < SOFT_ERROR_RATE_THRESHOLD;
}

/**
 * The health gate a zero-yield `'passed'` run must clear to render calm
 * (`'empty'`) rather than urgent (`'degraded'`) — ux-notes.md §1's literal
 * sentence: "all 10 stages completed **and** no failure record **and** no
 * open throttle breaker **and** soft-error rate below threshold."
 */
function passesHealthGate(
  run: RunDetail,
  softErrors: SoftErrorSummary | undefined,
): boolean {
  return (
    hasAllStages(run.result) &&
    hasNoFailureRecord(run.failure) &&
    !hasBreakerOpenWarn(softErrors) &&
    softErrorRateUnderThreshold(softErrors)
  );
}

/**
 * Classifies a run into the seven-way outcome vocabulary (ux-notes.md §1).
 * Precedence: `'running'` → `'unrecorded'` (the A6 real-DB-row shape) →
 * `'crashed'` → `'failed'` → then, for `status === 'passed'`, `'produced'`
 * when the last funnel stage yielded jobs, else the health gate decides
 * `'empty'` vs `'degraded'`.
 *
 * Narrowing note: `'produced'`/`'empty'`/`'degraded'` all need the funnel in
 * `RunDetail.result`, which a bare `RunSummary` doesn't carry. Called with a
 * `status === 'passed'` `RunSummary` (no `RunDetail` available), there is no
 * data to confirm health with — consistent with "calm is earned, not
 * defaulted," this fails safe to `'degraded'` rather than guessing calm.
 */
export function classifyOutcome(
  run: RunSummary | RunDetail,
  softErrors: SoftErrorSummary | undefined,
): OutcomeKind {
  if (run.status === 'running') return 'running';
  if (isUnrecorded(run)) return 'unrecorded';
  if (run.status === 'crashed') return 'crashed';
  if (run.status === 'failed') return 'failed';

  // status === 'passed'
  if (!isRunDetail(run)) return 'degraded';

  const stages = getFunnelStages(run.result);
  const lastJobsOut =
    stages && stages.length > 0 ? stages[stages.length - 1]?.jobsOut : 0;
  if (lastJobsOut !== undefined && lastJobsOut > 0) return 'produced';

  return passesHealthGate(run, softErrors) ? 'empty' : 'degraded';
}
