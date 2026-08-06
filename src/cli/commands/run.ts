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
 *  - Concurrency (P9 closure register §9, final item): before anything else
 *    (before the doctor preflight, before any stage), a cross-process,
 *    cross-profile lock (`ops/scheduling/run_lock.ts`) is acquired. If
 *    another run — any profile, any launchd time slot — is already
 *    holding it, this run is SKIPPED (not queued/waited): logged loudly,
 *    reported via a Telegram alert (not a digest), and returns 1 — never
 *    a bogus `passed`. The lock is released in a `finally` around
 *    everything else so a crash never wedges the next scheduled slot
 *    (see `run_lock.ts` for the stale-lock/crash-recovery rules).
 *
 * No `src/adapters/**` import here — `wire` is injected (real default:
 * `cli/wire/compose.ts`'s `wire`, the sole adapter-import chokepoint).
 */
import { join } from 'node:path';
import { runChecks } from '../../ops/doctor/aggregate.ts';
import {
  createRunLogger,
  formatDigest,
  formatRunTime,
  type RunResult,
  type RunStoreLogger,
} from '../../ops/observability/index.ts';
import {
  type AcquireLockResult,
  acquireRunLock,
  defaultRunLockDeps,
  releaseRunLock,
} from '../../ops/scheduling/run_lock.ts';
import type { PipelineCtx } from '../../pipeline/runner/context.ts';
import type { RunnerOptions } from '../../pipeline/runner/run.ts';
import { runPipeline as defaultRunPipeline } from '../../pipeline/runner/run.ts';
import type { StageDef, StagePayload } from '../../pipeline/runner/stage.ts';
import { computeRunCapMs } from '../../pipeline/stages/budgets.ts';
import type { Routine } from '../../routines/types.ts';
import {
  wire as defaultWire,
  resolveLoggingSettings,
  type WireResult,
} from '../wire/index.ts';

// > structure provider timeout (300_000) so the stall watchdog never
// false-kills a live batch.
const DEFAULT_STALL_MS = 360_000;

/**
 * The run-level cap (third watchdog layer, `runPipeline`'s `runCapMs`) MUST
 * exceed the worst case total every stage could legitimately take,
 * including whole-stage retries — each retry attempt gets its OWN fresh
 * `timeoutMs` budget (`guardStage`/`runOneAttempt`), so a stage with
 * `retries: 1` can legitimately consume `timeoutMs * 2` before the run
 * itself should even consider that a problem. Deriving the cap from the
 * live `stages` array (rather than a hardcoded constant) means this never
 * silently drifts out of sync again as stage budgets change — see P9
 * closure register item 2, whose broken run was caused by exactly that
 * drift (cap 30 min < sum of stage timeouts ~68 min).
 *
 * The arithmetic itself now lives in `pipeline/stages/budgets.ts` (Task
 * 8), re-exported here so every existing call site — this file's own
 * `computeRunCapMs(stages)` below, plus every test that imports
 * `computeRunCapMs` from `cli/commands/run.ts` — keeps working
 * unchanged. The live `stages` array satisfies `budgets.ts`'s `readonly
 * StageBudget[]` parameter structurally, so no adapter or cast is
 * needed at the call site.
 */
export { computeRunCapMs };

export interface RunCommandOptions {
  profile: string;
  resume?: boolean;
  headless?: boolean;
  /** P8 Task 7 (DB-backed as of runs-observability Phase 1 Task 6): computes
   * the sync stage's would-write set without writing to Notion — threaded
   * into `wire()` as `syncDryRun: true`, which the sync stage records via
   * `ctx.runStore.recordSyncDryrun(ctx.runId, report)` against THIS
   * invocation's own `runs` row (retiring the old per-date
   * `sync_dryrun.json` and the same-day-overwrite bug that came with it). */
  dryRun?: boolean;
  /** Operator override for the run-level cap (ms). Absent ⇒ derived from
   * the wired stages' own timeout/retry budgets (`computeRunCapMs`). */
  runCapMs?: number;
}

/** Lock file name at the repo root — see `ops/scheduling/run_lock.ts` for
 * why this exists (cross-slot launchd overlap, one shared Chrome/CDP
 * session) and the crash-recovery rules. Deliberately dot-prefixed and
 * top-level, alongside `.chrome-debug/` (both are "shared browser session"
 * bookkeeping, both gitignored). */
const RUN_LOCK_FILENAME = '.jobbunny-run.lock';

export interface RunDeps {
  wire: (
    profileName: string,
    overrides?: Parameters<typeof defaultWire>[1],
  ) => Promise<WireResult>;
  runPipeline: (
    stages: Array<StageDef<StagePayload, StagePayload>>,
    ctx: PipelineCtx,
    group: { date: string; timeDir: string },
    opts: RunnerOptions,
  ) => Promise<RunResult>;
  now: () => Date;
  root: string;
  /** Cross-process, cross-profile exclusive lock (`ops/scheduling/
   * run_lock.ts`) — makes two concurrent `run` invocations (any profiles,
   * any launchd time slot) impossible, since they'd otherwise fight over
   * the one shared Chrome/CDP session. Injected so tests never touch a
   * real lock file or a real process table. */
  acquireLock: (profile: string) => Promise<AcquireLockResult>;
  releaseLock: () => Promise<void>;
}

function defaultDeps(): RunDeps {
  const root = process.cwd();
  const lockPath = join(root, RUN_LOCK_FILENAME);
  return {
    wire: defaultWire,
    runPipeline: defaultRunPipeline,
    now: () => new Date(),
    root,
    acquireLock: async (profile) => acquireRunLock(defaultRunLockDeps(lockPath), profile),
    releaseLock: async () => releaseRunLock(defaultRunLockDeps(lockPath)),
  };
}

async function runRoutines(routines: Routine[], when: Routine['when'], ctx: PipelineCtx) {
  for (const routine of routines.filter((r) => r.when === when)) {
    await routine.run(ctx);
  }
}

function funnelSummary(result: RunResult, dryRun: boolean): string {
  const lines = [
    `profile=${result.profile} date=${result.date} outcome=${result.outcome}` +
      (dryRun ? ' [DRY RUN — sync not written to Notion]' : ''),
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

  const now = resolved.now();
  const date = now.toISOString().slice(0, 10);
  const { ctx, stages, routines, checks } = await resolved.wire(
    opts.profile,
    opts.dryRun ? { syncDryRun: true } : undefined,
  );

  // Cross-process, cross-profile exclusive lock (see `ops/scheduling/
  // run_lock.ts`) — acquired BEFORE the doctor preflight, before anything
  // touches the shared Chrome/CDP session. A held lock means another `run`
  // (any profile, possibly from a different launchd time slot whose
  // previous run overran) is still in flight: we SKIP rather than wait,
  // since waiting would just queue runs behind an already-overrunning one
  // with no bound of its own, and report it as a clear, non-`passed`
  // outcome via both the log and a Telegram alert (never silently, and
  // never as a bogus success).
  const lock = await resolved.acquireLock(opts.profile);
  if (!lock.acquired) {
    const heldBy = lock.heldBy;
    const message =
      `run skipped for profile "${opts.profile}" — another run is already in progress ` +
      `(profile "${heldBy.profile}", pid ${heldBy.pid}, started ${heldBy.startedAt}); ` +
      'refusing to start concurrently (all profiles share one Chrome/CDP session)';
    console.error(`[run] ${message}`);
    await ctx.notify({
      kind: 'alert',
      profile: opts.profile,
      text: `⏭️ Job Bunny — ${opts.profile} run SKIPPED\n${message}`,
    });
    return 1;
  }

  // Set once the runs-observability row is open (below), so the `finally`
  // can flush its buffered events even on an unexpected throw. Undefined
  // only when the run never got that far (e.g. the doctor preflight abort,
  // which returns before any row is opened).
  let runLogger: RunStoreLogger | undefined;

  try {
    // Doctor preflight (P9 closure register item 1): a `red` finding must
    // abort BEFORE any stage runs — reuses doctorCommand's own aggregation
    // (`runChecks`) rather than re-implementing the ok/warn/red evaluation
    // here. No `RunResult` exists yet at this point, so there is nothing to
    // notify/format a funnel summary for; this mirrors `doctorCommand`
    // itself, which just reports and exits non-zero.
    const preflight = await runChecks(checks);
    if (preflight.status === 'red') {
      const failing = preflight.findings
        .filter((f) => f.status === 'red')
        .map((f) => `${f.check}: ${f.detail}`)
        .join('; ');
      console.error(
        `doctor preflight failed — aborting run before any stage: ${failing}`,
      );
      return 1;
    }

    // This invocation always gets its OWN fresh time-dir group — checkpoints
    // are per-run, never last-writer-wins per day (see
    // `ctx.checkpointStore.nextTimeDir`, `formatRunTime`). `time` is the
    // LOCAL clock's HH-MM, matching `schedule.times`'s own local-clock
    // convention.
    const time = ctx.checkpointStore.nextTimeDir(date, formatRunTime(now));

    // `--resume`: seed from the latest EARLIER same-day group's latest
    // checkpoint (never this run's own — its group doesn't exist in the
    // store yet, so `latestCheckpointTimeDir` naturally excludes it). Group
    // discovery lives here, not in `runPipeline`, which only ever sees the
    // resolved seed. `latestCheckpointTimeDir`, NOT `latestTimeDir`: a prior
    // group that only ever opened a `runs` row (died before its first
    // checkpoint) must never shadow an earlier group that actually has one.
    let resumeFrom: RunnerOptions['resumeFrom'];
    let resumedFrom: number | undefined;
    if (opts.resume ?? false) {
      const priorTime = ctx.checkpointStore.latestCheckpointTimeDir(date);
      if (priorTime !== undefined) {
        const latest = ctx.checkpointStore.readLatest(date, priorTime);
        if (latest) {
          resumeFrom = {
            startIndex: latest.ref.position + 1,
            payload: latest.payload as StagePayload,
            checkpointPath: `${latest.ref.runDate}/${latest.ref.timeDir}#${latest.ref.position}-${latest.ref.stage}`,
          };
          // L18c fix, now structurally guaranteed by `latestCheckpointTimeDir`
          // itself (it only ever returns a `time_dir` with a real checkpoint
          // row) — resolve resumedFrom ONLY when a checkpoint was actually
          // found, so a prior group that is only a bare `runs` row (no
          // checkpoints yet) can never report a bogus resumedFrom pointing
          // at a run this invocation never actually continued from. The
          // `if (latest)` guard above stays as defense-in-depth.
          resumedFrom = ctx.runStore.findRunId(date, priorTime) ?? undefined;
        }
      }
    }

    // Runs-observability Phase 1 (Task 6): open this invocation's `runs`
    // row before anything else touches it — `ctx.runId` is what
    // `runPipeline` keys its heartbeat/failure recording off, and
    // `finishRun` below closes the same row once the pipeline returns.
    const runId = ctx.runStore.startRun({
      date,
      timeDir: time,
      kind: 'run',
      startedAt: now.toISOString(),
      ...(resumedFrom !== undefined ? { resumedFrom } : {}),
    });
    ctx.runId = runId;
    runLogger = createRunLogger(
      ctx.runStore,
      runId,
      resolveLoggingSettings(
        ctx.config.settings?.logging,
        process.env.JOBBUNNY_TTY_LOG_LEVEL,
      ),
    );
    ctx.logger = runLogger;

    await runRoutines(routines, 'pre-run', ctx);

    const result = await resolved.runPipeline(
      stages,
      ctx,
      { date, timeDir: time },
      {
        runCapMs: opts.runCapMs ?? computeRunCapMs(stages),
        stallMs: DEFAULT_STALL_MS,
        ...(resumeFrom ? { resumeFrom } : {}),
      },
    );

    ctx.runStore.finishRun(runId, result.outcome, result, resolved.now().toISOString());

    if (result.outcome === 'passed') {
      await runRoutines(routines, 'post-sync', ctx);
    }

    await ctx.notify({
      kind: 'digest',
      profile: opts.profile,
      text: formatDigest(result, { dryRun: opts.dryRun ?? false }),
    });

    console.log(funnelSummary(result, opts.dryRun ?? false));

    return result.outcome === 'passed' ? 0 : 1;
  } finally {
    // Flush any buffered run_events before releasing the lock — durability
    // before the process is free to exit (mirrors the old `JsonlLogger`
    // `flush()` convention this replaces).
    runLogger?.flush();
    // Always release — including on the preflight-abort early return above
    // and on any unexpected throw — so a failed/aborted run never leaves
    // the NEXT scheduled slot permanently locked out.
    await resolved.releaseLock();
  }
}
