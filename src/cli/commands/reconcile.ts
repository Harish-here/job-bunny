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
 * `cli/wire/compose.ts`'s `wire`, the sole adapter-import chokepoint).
 */
import { join } from 'node:path';
import { z } from 'zod';
import { CacheEntrySchema } from '../../core/jd/index.ts';
import {
  createRunLogger,
  formatRunTime,
  latestTimeDir,
  RunFolder,
  type RunResult,
} from '../../ops/observability/index.ts';
import type { PipelineCtx } from '../../pipeline/runner/context.ts';
import type { RunnerOptions } from '../../pipeline/runner/run.ts';
import { runPipeline as defaultRunPipeline } from '../../pipeline/runner/run.ts';
import type { StageDef, StagePayload } from '../../pipeline/runner/stage.ts';
import { CACHE_PATH } from '../../pipeline/stages/reconcile.ts';
import {
  wire as defaultWire,
  resolveLoggingSettings,
  type WireResult,
} from '../wire/index.ts';

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

  const now = resolved.now();
  const date = now.toISOString().slice(0, 10);
  const dataDir = join(resolved.root, 'profiles', opts.profile, 'data');
  // Same folder-selection semantics as `stageCommand`: continue in TODAY's
  // latest existing time folder (this and `stage` are both ad-hoc
  // single-stage entry points in the same verify chain), creating a fresh
  // one only when today has none yet.
  const existing = await latestTimeDir(dataDir, date);
  const time = existing ?? formatRunTime(now);
  const folder = new RunFolder(dataDir, date, time);
  // Placeholder runId — Task 7 replaces this with the real run/stage row id.
  ctx.logger = createRunLogger(
    ctx.runStore,
    -1,
    resolveLoggingSettings(
      ctx.config.settings?.logging,
      process.env.JOBBUNNY_TTY_LOG_LEVEL,
    ),
  );

  const result = await resolved.runPipeline([reconcileStage], ctx, folder, {
    runCapMs: RUN_CAP_MS,
    stallMs: STALL_MS,
  });

  if (result.outcome === 'failed') {
    resolved.write(`reconcile: failed — ${result.failedStage ?? 'unknown stage'}`);
    return 1;
  }

  const cache = await ctx.storage.readJson(CACHE_PATH, z.array(CacheEntrySchema));
  resolved.write(`reconcile: cache rebuilt (${cache?.length ?? 0} entries)`);

  return 0;
}
