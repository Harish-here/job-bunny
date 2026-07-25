/**
 * commands/run.ts (P8) — the `run` CLI command: wires a profile, runs the
 * pipeline, fans out the digest, and returns the process exit code.
 *
 * Design (locked, main-v2 P8 packet):
 *  - `pre-run` routines always run, before `runPipeline`.
 *  - `post-sync` routines run ONLY when the run passed.
 *  - The digest is sent on BOTH outcomes — exactly once, here, the single
 *    sender (`runPipeline` itself sends nothing — see its header).
 *  - A crash before a `RunResult` exists (e.g. `wire()` throwing) propagates
 *    to `main`'s try/catch, which returns 1 without ever calling `notify`.
 *
 * No `src/adapters/**` import here — `wire` is injected (real default:
 * `cli/wire.ts`'s `wire`, the sole adapter-import chokepoint).
 */
import { join } from 'node:path';
import { formatDigest } from '../../ops/observability/digest.ts';
import { JsonlLogger } from '../../ops/observability/logger.ts';
import type { RunResult } from '../../ops/observability/result.ts';
import { RunFolder } from '../../ops/observability/run_folder.ts';
import type { PipelineCtx } from '../../pipeline/runner/context.ts';
import type { RunnerOptions } from '../../pipeline/runner/run.ts';
import { runPipeline as defaultRunPipeline } from '../../pipeline/runner/run.ts';
import type { StageDef, StagePayload } from '../../pipeline/runner/stage.ts';
import type { Routine } from '../../routines/types.ts';
import { wire as defaultWire, type WireResult } from '../wire.ts';

const DEFAULT_RUN_CAP_MS = 1_800_000;
// > structure provider timeout (300_000) so the stall watchdog never
// false-kills a live batch.
const DEFAULT_STALL_MS = 360_000;

export interface RunCommandOptions {
  profile: string;
  resume?: boolean;
  headless?: boolean;
}

export interface RunDeps {
  wire: (profileName: string) => Promise<WireResult>;
  runPipeline: (
    stages: Array<StageDef<StagePayload, StagePayload>>,
    ctx: PipelineCtx,
    folder: RunFolder,
    opts: RunnerOptions,
  ) => Promise<RunResult>;
  now: () => Date;
  root: string;
}

function defaultDeps(): RunDeps {
  return {
    wire: defaultWire,
    runPipeline: defaultRunPipeline,
    now: () => new Date(),
    root: process.cwd(),
  };
}

async function runRoutines(routines: Routine[], when: Routine['when'], ctx: PipelineCtx) {
  for (const routine of routines.filter((r) => r.when === when)) {
    await routine.run(ctx);
  }
}

function funnelSummary(result: RunResult): string {
  const lines = [
    `profile=${result.profile} date=${result.date} outcome=${result.outcome}`,
  ];
  if (result.outcome === 'failed' && result.failedStage) {
    lines.push(`failed at: ${result.failedStage}`);
  }
  for (const stage of result.stages) {
    lines.push(`  ${stage.name}: ${stage.jobsIn} -> ${stage.jobsOut}`);
  }
  return lines.join('\n');
}

export async function runCommand(
  opts: RunCommandOptions,
  deps: Partial<RunDeps> = {},
): Promise<number> {
  const resolved: RunDeps = { ...defaultDeps(), ...deps };
  const { ctx, stages, routines } = await resolved.wire(opts.profile);

  const date = resolved.now().toISOString().slice(0, 10);
  const folder = new RunFolder(
    join(resolved.root, 'profiles', opts.profile, 'data'),
    date,
  );
  ctx.logger = new JsonlLogger(folder.logPath());

  await runRoutines(routines, 'pre-run', ctx);

  const result = await resolved.runPipeline(stages, ctx, folder, {
    runCapMs: DEFAULT_RUN_CAP_MS,
    stallMs: DEFAULT_STALL_MS,
    resume: opts.resume ?? false,
  });

  if (result.outcome === 'passed') {
    await runRoutines(routines, 'post-sync', ctx);
  }

  await ctx.notify({ kind: 'digest', profile: opts.profile, text: formatDigest(result) });

  console.log(funnelSummary(result));

  return result.outcome === 'passed' ? 0 : 1;
}
