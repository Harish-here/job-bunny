/**
 * commands/reconcile.ts (P8) — the `reconcile` CLI command: wires a
 * profile, runs ONLY the `reconcile` stage (found by `stage.name`, never by
 * array index — `wire()`'s stage order is an implementation detail this
 * command must not assume), and reports how many cache entries the rebuilt
 * `cache.json` mirror holds.
 *
 * Reuses the same runner machinery `run` does (`runPipeline` against a
 * `RunFolder` for today's date) rather than inventing a parallel
 * single-stage path — the reconcile stage is simply handed a one-element
 * `stages` array. `runPipeline` itself never throws (a stage failure comes
 * back as a `RunResult` with `outcome: 'failed'`); this command turns that
 * into an exit code and message rather than propagating a throw.
 *
 * No `src/adapters/**` import here — `wire` is injected (real default:
 * `cli/wire.ts`'s `wire`, the sole adapter-import chokepoint).
 */
import { join } from 'node:path';
import { z } from 'zod';
import { CacheEntrySchema } from '../../core/jd/index.ts';
import { JsonlLogger } from '../../ops/observability/logger.ts';
import type { RunResult } from '../../ops/observability/result.ts';
import { RunFolder } from '../../ops/observability/run_folder.ts';
import type { PipelineCtx } from '../../pipeline/runner/context.ts';
import type { RunnerOptions } from '../../pipeline/runner/run.ts';
import { runPipeline as defaultRunPipeline } from '../../pipeline/runner/run.ts';
import type { StageDef, StagePayload } from '../../pipeline/runner/stage.ts';
import { CACHE_PATH } from '../../pipeline/stages/reconcile.ts';
import { wire as defaultWire, type WireResult } from '../wire.ts';

const RUN_CAP_MS = 1_800_000;
const STALL_MS = 360_000;

export interface ReconcileCommandOptions {
  profile: string;
}

export interface ReconcileDeps {
  wire: (profileName: string) => Promise<WireResult>;
  runPipeline: (
    stages: Array<StageDef<StagePayload, StagePayload>>,
    ctx: PipelineCtx,
    folder: RunFolder,
    opts: RunnerOptions,
  ) => Promise<RunResult>;
  now: () => Date;
  root: string;
  write: (line: string) => void;
}

function defaultDeps(): ReconcileDeps {
  return {
    wire: defaultWire,
    runPipeline: defaultRunPipeline,
    now: () => new Date(),
    root: process.cwd(),
    write: (line: string) => console.log(line),
  };
}

export async function reconcileCommand(
  opts: ReconcileCommandOptions,
  deps: Partial<ReconcileDeps> = {},
): Promise<number> {
  const resolved: ReconcileDeps = { ...defaultDeps(), ...deps };
  const { ctx, stages } = await resolved.wire(opts.profile);

  const reconcileStage = stages.find((s) => s.name === 'reconcile');
  if (!reconcileStage) {
    throw new Error('wire() did not produce a "reconcile" stage');
  }

  const date = resolved.now().toISOString().slice(0, 10);
  const folder = new RunFolder(
    join(resolved.root, 'profiles', opts.profile, 'data'),
    date,
  );
  ctx.logger = new JsonlLogger(folder.logPath());

  const result = await resolved.runPipeline([reconcileStage], ctx, folder, {
    runCapMs: RUN_CAP_MS,
    stallMs: STALL_MS,
    resume: false,
  });

  if (result.outcome === 'failed') {
    resolved.write(`reconcile: failed — ${result.failedStage ?? 'unknown stage'}`);
    return 1;
  }

  const cache = await ctx.storage.readJson(CACHE_PATH, z.array(CacheEntrySchema));
  resolved.write(`reconcile: cache rebuilt (${cache?.length ?? 0} entries)`);

  return 0;
}
