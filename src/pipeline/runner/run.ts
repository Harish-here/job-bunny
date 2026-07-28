import {
  buildFunnel,
  type RunFolder,
  type RunResult,
} from '../../ops/observability/index.ts';
import type { PipelineCtx } from './context.ts';
import { guardStage } from './guard.ts';
import type { StageDef, StagePayload } from './stage.ts';

export interface RunnerOptions {
  runCapMs: number; // global cap — third watchdog layer
  stallMs: number;
  /** Explicit resume seed, discovered by the CALLER (e.g. the `run` CLI
   * command finding an earlier same-day run folder) — the runner itself
   * never does folder discovery. Absent ⇒ start from stage 0 with the
   * empty seed payload. `checkpointPath` (when known) is only used to
   * populate `failure.json`'s `lastCheckpoint` if the very first resumed
   * stage fails before this run writes a checkpoint of its own. */
  resumeFrom?: {
    startIndex: number;
    payload: StagePayload;
    checkpointPath?: string;
  };
}

const SEED_PAYLOAD: StagePayload = { jobs: [], dropped: [] };

/**
 * Runs `stages` sequentially, checkpointing each successful output and
 * writing failure.json/result.json to `folder`. Never throws — a stage
 * failure (including a run-cap/run-level abort) is captured as a 'failed'
 * RunResult and returned so the caller decides the process exit code.
 * Sends nothing to notifiers (single-sender invariant lives in P8).
 */
export async function runPipeline(
  stages: Array<StageDef<StagePayload, StagePayload>>,
  ctx: PipelineCtx,
  folder: RunFolder,
  opts: RunnerOptions,
): Promise<RunResult> {
  const runStarted = Date.now();
  const runSignal = AbortSignal.any([ctx.signal, AbortSignal.timeout(opts.runCapMs)]);
  const runCtx: PipelineCtx = { ...ctx, signal: runSignal };

  let startIndex = 0;
  let input: StagePayload = SEED_PAYLOAD;
  let lastCheckpointPath: string | undefined = opts.resumeFrom?.checkpointPath;

  if (opts.resumeFrom) {
    startIndex = opts.resumeFrom.startIndex;
    input = opts.resumeFrom.payload;
  }

  const resultStages: RunResult['stages'] = [];

  for (const [index, stage] of stages.entries()) {
    if (index < startIndex) continue;

    const stageStarted = Date.now();
    try {
      const { output, attempts } = await guardStage(stage, input, runCtx, {
        stallMs: opts.stallMs,
      });
      const elapsedMs = Date.now() - stageStarted;
      await folder.writeCheckpoint(index, stage.name, output);
      lastCheckpointPath = folder.checkpointPath(index, stage.name);
      const funnel = buildFunnel(input, output);
      resultStages.push({
        name: stage.name,
        elapsedMs,
        attempts,
        jobsIn: funnel.jobsIn,
        jobsOut: funnel.jobsOut,
        dropsByRule: funnel.dropsByRule,
      });
      input = output;
    } catch (err) {
      const elapsedMs = Date.now() - runStarted;
      const error = errorText(err);
      await folder.writeFailure({
        stage: stage.name,
        error,
        elapsedMs,
        ...(lastCheckpointPath !== undefined
          ? { lastCheckpoint: lastCheckpointPath }
          : {}),
      });
      const result: RunResult = {
        profile: ctx.profile,
        date: folder.date,
        time: folder.time,
        outcome: 'failed',
        failedStage: stage.name,
        stages: resultStages,
      };
      await folder.writeResult(result);
      return result;
    }
  }

  const result: RunResult = {
    profile: ctx.profile,
    date: folder.date,
    time: folder.time,
    outcome: 'passed',
    stages: resultStages,
  };
  await folder.clearFailure();
  await folder.writeResult(result);
  return result;
}

/** Renders an error for failure.json. When `err` is an Error with a
 * non-null `cause`, the cause's message is appended (`<message> — cause:
 * <causeMessage>`) so a wrapping error (e.g. guardStage's "stage ... failed
 * after N attempt(s)") doesn't hide the underlying attempt failure. */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause !== null && cause !== undefined) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    return `${err.message} — cause: ${causeMessage}`;
  }
  return err.message;
}
