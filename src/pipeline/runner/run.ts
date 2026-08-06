import { buildFunnel, type RunResult, withScope } from '../../ops/observability/index.ts';
import type { PipelineCtx } from './context.ts';
import { guardStage } from './guard.ts';
import type { StageDef, StagePayload } from './stage.ts';

export interface RunnerOptions {
  runCapMs: number; // global cap — third watchdog layer
  stallMs: number;
  /** Explicit resume seed, discovered by the CALLER (e.g. the `run` CLI
   * command finding an earlier same-day group) — the runner itself never
   * does group discovery. Absent ⇒ start from stage 0 with the empty seed
   * payload. `checkpointPath` (when known) is a display-only descriptor
   * (`<date>/<timeDir>#<position>-<stage>`) — only used to populate the
   * recorded failure's `lastCheckpoint` if the very first resumed stage
   * fails before this run writes a checkpoint of its own; never parsed
   * back into its components. */
  resumeFrom?: {
    startIndex: number;
    payload: StagePayload;
    checkpointPath?: string;
  };
}

const SEED_PAYLOAD: StagePayload = { jobs: [], dropped: [] };

/**
 * Runs `stages` sequentially, checkpointing each successful output to
 * `ctx.checkpointStore`. Heartbeats and stage failures are recorded via
 * `ctx.runStore` when `ctx.runId` is set (runs-observability Phase 1) —
 * result/failure files are no longer written here; the driver persists the
 * returned `RunResult` itself. Never throws — a stage failure (including a
 * run-cap/run-level abort, or a checkpoint write failure) is captured as a
 * 'failed' RunResult and returned so the caller decides the process exit
 * code. Sends nothing to notifiers (single-sender invariant lives in P8).
 */
export async function runPipeline(
  stages: Array<StageDef<StagePayload, StagePayload>>,
  ctx: PipelineCtx,
  group: { date: string; timeDir: string },
  opts: RunnerOptions,
): Promise<RunResult> {
  const runStarted = Date.now();
  const runSignal = AbortSignal.any([ctx.signal, AbortSignal.timeout(opts.runCapMs)]);
  const runCtx: PipelineCtx = { ...ctx, signal: runSignal };

  let startIndex = 0;
  let input: StagePayload = SEED_PAYLOAD;
  let lastCheckpointDescriptor: string | undefined = opts.resumeFrom?.checkpointPath;

  if (opts.resumeFrom) {
    startIndex = opts.resumeFrom.startIndex;
    input = opts.resumeFrom.payload;
  }

  const resultStages: RunResult['stages'] = [];

  for (const [index, stage] of stages.entries()) {
    if (index < startIndex) continue;

    if (ctx.runId !== undefined) {
      ctx.runStore.heartbeat(ctx.runId, new Date().toISOString());
    }

    const stageStarted = Date.now();
    try {
      const stageCtx: PipelineCtx = {
        ...runCtx,
        logger: withScope(runCtx.logger, stage.name),
      };
      const { output, attempts } = await guardStage(stage, input, stageCtx, {
        stallMs: opts.stallMs,
      });
      const elapsedMs = Date.now() - stageStarted;
      ctx.checkpointStore.write(
        {
          runDate: group.date,
          timeDir: group.timeDir,
          position: index,
          stage: stage.name,
        },
        output,
      );
      lastCheckpointDescriptor = `${group.date}/${group.timeDir}#${index}-${stage.name}`;
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
      if (ctx.runId !== undefined) {
        ctx.runStore.recordFailure(ctx.runId, {
          stage: stage.name,
          error,
          elapsedMs,
          ...(lastCheckpointDescriptor !== undefined
            ? { lastCheckpoint: lastCheckpointDescriptor }
            : {}),
        });
      }
      const result: RunResult = {
        profile: ctx.profile,
        date: group.date,
        time: group.timeDir,
        outcome: 'failed',
        failedStage: stage.name,
        stages: resultStages,
      };
      return result;
    }
  }

  const result: RunResult = {
    profile: ctx.profile,
    date: group.date,
    time: group.timeDir,
    outcome: 'passed',
    stages: resultStages,
  };
  return result;
}

/** Renders an error for `recordFailure`/the returned RunResult. When `err`
 * is an Error with a non-null `cause`, the cause's message is appended (`<message> — cause:
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
