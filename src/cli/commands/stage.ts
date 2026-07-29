/**
 * commands/stage.ts (P8) — the `stage <name>` CLI command: runs a SINGLE
 * named stage from a profile's `wire()`-produced `stages` array, resuming
 * from the latest checkpoint in today's `RunFolder` (falling back to the
 * empty seed payload `{ jobs: [], dropped: [] }` when there is none yet).
 *
 * Reuses the runner's own checkpoint/resume machinery rather than
 * inventing a parallel one: `RunFolder.readLatestCheckpoint` for the
 * input, `guardStage` (pipeline/runner/guard.ts — the same per-attempt
 * timeout/stall/retry wrapper `runPipeline` uses internally) to execute
 * the stage, and `RunFolder.writeCheckpoint` at the stage's own position
 * in the full `stages` array (so a later full `run --resume` picks up
 * exactly where this ad-hoc stage run left off).
 *
 * An unknown stage name is a USER error, not a crash: it prints the valid
 * names and returns exit code 1 rather than throwing into `main`'s catch.
 *
 * No `src/adapters/**` import here — `wire` is injected (real default:
 * `cli/wire/compose.ts`'s `wire`, the sole adapter-import chokepoint).
 */
import { join } from 'node:path';
import {
  buildFunnel,
  createRunLogger,
  formatRunTime,
  latestTimeDir,
  RunFolder,
  withScope,
} from '../../ops/observability/index.ts';
import type { PipelineCtx } from '../../pipeline/runner/context.ts';
import { guardStage } from '../../pipeline/runner/guard.ts';
import type { StagePayload } from '../../pipeline/runner/stage.ts';
import {
  wire as defaultWire,
  resolveLoggingSettings,
  type WireResult,
} from '../wire/index.ts';

const STALL_MS = 360_000; // matches run.ts's DEFAULT_STALL_MS — see its header
const SEED_PAYLOAD: StagePayload = { jobs: [], dropped: [] };

export interface StageCommandOptions {
  profile: string;
  stage: string;
}

export interface StageDeps {
  wire: (profileName: string) => Promise<WireResult>;
  now: () => Date;
  root: string;
  write: (line: string) => void;
}

function defaultDeps(): StageDeps {
  return {
    wire: defaultWire,
    now: () => new Date(),
    root: process.cwd(),
    write: (line: string) => console.log(line),
  };
}

export async function stageCommand(
  opts: StageCommandOptions,
  deps: Partial<StageDeps> = {},
): Promise<number> {
  const resolved: StageDeps = { ...defaultDeps(), ...deps };
  const { ctx, stages } = await resolved.wire(opts.profile);

  const index = stages.findIndex((s) => s.name === opts.stage);
  if (index === -1) {
    const names = stages.map((s) => s.name).join(', ');
    resolved.write(`unknown stage "${opts.stage}" — valid stages: ${names}`);
    return 1;
  }
  const target = stages[index];
  if (!target) {
    throw new Error(`internal error: stage "${opts.stage}" resolved to index ${index}`);
  }

  const now = resolved.now();
  const date = now.toISOString().slice(0, 10);
  const dataDir = join(resolved.root, 'profiles', opts.profile, 'data');
  // Continue in TODAY's latest existing time folder if one exists — this
  // keeps a chain of sequential single-stage runs (e.g. the verify skill's
  // `stage filter` → `stage dedup` → `stage rank`) sharing checkpoints.
  // Only when today has no folder yet does this create a fresh one.
  const existing = await latestTimeDir(dataDir, date);
  const time = existing ?? formatRunTime(now);
  const folder = new RunFolder(dataDir, date, time);
  ctx.logger = createRunLogger(
    folder.logPath(),
    resolveLoggingSettings(
      ctx.config.settings?.logging,
      process.env.JOBBUNNY_TTY_LOG_LEVEL,
    ),
  );

  const latest = await folder.readLatestCheckpoint();
  const input: StagePayload =
    (latest?.payload as StagePayload | undefined) ?? SEED_PAYLOAD;

  const stageCtx: PipelineCtx = { ...ctx, logger: withScope(ctx.logger, target.name) };
  const { output } = await guardStage(target, input, stageCtx, { stallMs: STALL_MS });

  await folder.writeCheckpoint(index, target.name, output);

  const funnel = buildFunnel(input, output);
  resolved.write(`${target.name}: ${funnel.jobsIn} -> ${funnel.jobsOut}`);

  return 0;
}
