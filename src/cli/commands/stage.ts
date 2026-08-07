/**
 * commands/stage.ts (P8 / DB Phase 2 Task 7) — the `stage <name>` CLI
 * command: runs a SINGLE named stage from a profile's `wire()`-produced
 * `stages` array, resuming from the latest checkpoint in TODAY's group
 * (falling back to the empty seed payload `{ jobs: [], dropped: [] }` when
 * there is none yet).
 *
 * Checkpoints live in `ctx.checkpointStore` (a `SqliteCheckpointStore`
 * over the profile's `jobbunny.db`), not a per-run directory tree —
 * `latestCheckpointTimeDir`/`readLatest` resolve TODAY's group (the last
 * one with an ACTUAL checkpoint, never a bare `runs` row) and its latest
 * payload; `write` persists this stage's own output at its real position
 * in the full `stages` array (so a later full `run --resume` picks up
 * exactly where this ad-hoc stage run left off). Unlike `run.ts`'s resume
 * logic (which reads a PRIOR, earlier group before starting a NEW one),
 * `stageCommand` always reads and writes within ONE group — today's
 * latest-existing-or-fresh — which is exactly the chain-continuation
 * semantic a sequence of single-stage runs (e.g. the verify skill's
 * `stage filter` → `stage dedup` → `stage rank`) relies on.
 *
 * `guardStage` (pipeline/runner/guard.ts — the same per-attempt
 * timeout/stall/retry wrapper `runPipeline` uses internally) executes the
 * stage itself.
 *
 * An unknown stage name is a USER error, not a crash: it prints the valid
 * names and returns exit code 1 rather than throwing into `main`'s catch.
 *
 * Checkpoint writes are LOUD (`CheckpointStore.write` throws on failure):
 * that throw lands in the same try/catch as a `guardStage` failure, so it
 * is recorded via `recordFailure`/`finishRun('failed', ...)` and rethrown
 * exactly like any other stage failure — no separate error handling needed.
 *
 * No `src/adapters/**` import here — `wire` is injected (real default:
 * `cli/wire/compose.ts`'s `wire`, the sole adapter-import chokepoint).
 */
import {
  buildFunnel,
  createRunLogger,
  formatRunTime,
  type RunResult,
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

/** Mirrors `pipeline/runner/run.ts`'s private `errorText` — duplicated
 * rather than exported, since it's runner-internal (not part of the P3
 * handoff contract) and this is the one other call site that needs the same
 * "don't hide the underlying attempt failure behind guardStage's wrapper
 * message" behavior for a recorded `RunFailure.error`. */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause !== null && cause !== undefined) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    return `${err.message} — cause: ${causeMessage}`;
  }
  return err.message;
}

const STALL_MS = 360_000; // matches run.ts's DEFAULT_STALL_MS — see its header
const SEED_PAYLOAD: StagePayload = { jobs: [], dropped: [] };

export interface StageCommandOptions {
  profile: string;
  stage: string;
}

export interface StageDeps {
  wire: (profileName: string) => Promise<WireResult>;
  now: () => Date;
  write: (line: string) => void;
}

function defaultDeps(): StageDeps {
  return {
    wire: defaultWire,
    now: () => new Date(),
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
  // Continue in TODAY's latest existing CHECKPOINTED group if one exists —
  // this keeps a chain of sequential single-stage runs (e.g. the verify
  // skill's `stage filter` → `stage dedup` → `stage rank`) sharing
  // checkpoints. `latestCheckpointTimeDir`, NOT `latestTimeDir`: a bare
  // `runs` row from a run that died before its first checkpoint must never
  // be treated as "today's existing group" — this stage would then read
  // `undefined` and silently fall back to the empty seed payload instead of
  // continuing the real prior chain. Only when today has no CHECKPOINTED
  // group yet does this create a fresh one.
  const existing = ctx.checkpointStore.latestCheckpointTimeDir(date);
  const time = existing ?? formatRunTime(now);

  // Runs-observability Phase 1 (Task 7): open a `runs` row for THIS
  // single-stage invocation — mirrors `runCommand` (Task 6) so the
  // store-backed logger has a real id to key its buffered events off,
  // instead of the previous placeholder `-1`.
  const runId = ctx.runStore.startRun({
    date,
    timeDir: time,
    kind: 'stage',
    startedAt: now.toISOString(),
  });
  // Heartbeat promptly — unlike a full `run`, this command drives `guardStage`
  // directly rather than `runPipeline` (run.ts:64), so nothing else would
  // ever touch heartbeat_at for the row. Without this, a long single stage
  // (e.g. `stage farm`) leaves heartbeat_at NULL for its whole duration,
  // which the null-or-stale derivation reports as "crashed" while it's alive.
  ctx.runStore.heartbeat(runId, resolved.now().toISOString());
  // Never propagate the degraded run store's sentinel (`startRun` returns
  // -1 when the store failed to open — ports/run_store.ts) into `ctx.runId`
  // or the checkpoint write's `writtenBy` below: `checkpoints.written_by`
  // is a real FK against `runs(id)`, and no row with id -1 ever exists, so
  // passing it through unguarded would make the checkpoint write throw and
  // fail an otherwise-healthy run — inverting "observability must never red
  // a run". `runId` (the local, unnormalized value) still goes to this
  // driver's own heartbeat/finishRun/recordFailure calls — those are
  // no-ops on the degraded store, so -1 is harmless there.
  const writtenBy = runId === -1 ? undefined : runId;
  ctx.runId = writtenBy;
  const runLogger = createRunLogger(
    ctx.runStore,
    runId,
    resolveLoggingSettings(
      ctx.config.settings?.logging,
      process.env.JOBBUNNY_TTY_LOG_LEVEL,
    ),
  );
  ctx.logger = runLogger;

  const latest = ctx.checkpointStore.readLatest(date, time);
  const input: StagePayload =
    (latest?.payload as StagePayload | undefined) ?? SEED_PAYLOAD;

  const stageStarted = Date.now();
  try {
    const stageCtx: PipelineCtx = { ...ctx, logger: withScope(ctx.logger, target.name) };
    const { output, attempts } = await guardStage(target, input, stageCtx, {
      stallMs: STALL_MS,
    });
    const elapsedMs = Date.now() - stageStarted;

    ctx.checkpointStore.write(
      {
        runDate: date,
        timeDir: time,
        position: index,
        stage: target.name,
        ...(writtenBy !== undefined ? { writtenBy } : {}),
      },
      output,
    );

    const funnel = buildFunnel(input, output);
    const result: RunResult = {
      profile: ctx.profile,
      date,
      time,
      outcome: 'passed',
      stages: [
        {
          name: target.name,
          elapsedMs,
          attempts,
          jobsIn: funnel.jobsIn,
          jobsOut: funnel.jobsOut,
          dropsByRule: funnel.dropsByRule,
        },
      ],
    };
    ctx.runStore.finishRun(runId, 'passed', result, resolved.now().toISOString());

    resolved.write(`${target.name}: ${funnel.jobsIn} -> ${funnel.jobsOut}`);

    return 0;
  } catch (err) {
    const elapsedMs = Date.now() - stageStarted;
    ctx.runStore.recordFailure(runId, {
      stage: target.name,
      error: errorText(err),
      elapsedMs,
    });
    const result: RunResult = {
      profile: ctx.profile,
      date,
      time,
      outcome: 'failed',
      failedStage: target.name,
      stages: [],
    };
    ctx.runStore.finishRun(runId, 'failed', result, resolved.now().toISOString());
    throw err;
  } finally {
    runLogger.flush();
  }
}
