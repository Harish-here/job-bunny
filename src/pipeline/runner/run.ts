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
  resume: boolean; // same-day: skip stages ≤ latest checkpoint
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
  let lastCheckpointPath: string | undefined;

  if (opts.resume) {
    const latest = await folder.readLatestCheckpoint();
    if (latest) {
      startIndex = latest.index + 1;
      input = latest.payload as StagePayload;
      lastCheckpointPath = folder.checkpointPath(latest.index, latest.stage);
    }
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
      const error = err instanceof Error ? err.message : String(err);
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
    outcome: 'passed',
    stages: resultStages,
  };
  await folder.writeResult(result);
  return result;
}
