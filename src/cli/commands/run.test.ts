/**
 * run.test.ts (P8) — TDD for `runCommand`. Every dependency (`wire`,
 * `runPipeline`, `now`, `acquireLock`/`releaseLock`, `runStore`,
 * `checkpointStore`) is FAKE — no real filesystem or lock file is ever
 * exercised here. `fakeLockDeps()` below is spread into every test's deps
 * so `runCommand`'s new lock acquisition always succeeds by default — the
 * lock-specific behavior (skip on a held lock) gets its own dedicated
 * tests further down.
 *
 * The `--resume` group-discovery/resumedFrom tests live in
 * `run.resume.test.ts`, split out (checkpoints-to-db Phase 2 Task 6) to
 * stay under the 800-line test-file cap — mirrors
 * `cli/wire/compose.checkpointstore.test.ts`'s split precedent.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatRunTime, type RunResult } from '../../ops/observability/index.ts';
import type { LockInfo } from '../../ops/scheduling/run_lock.ts';
import type { PipelineCtx } from '../../pipeline/runner/context.ts';
import type { RunnerOptions } from '../../pipeline/runner/run.ts';
import type { StageDef, StagePayload } from '../../pipeline/runner/stage.ts';
import type { CheckpointRef, CheckpointStore } from '../../ports/checkpoint_store.ts';
import type { DoctorCheck } from '../../ports/doctor.ts';
import type { NotifyEvent } from '../../ports/notifier.ts';
import type { RunStore } from '../../ports/run_store.ts';
import type { Routine } from '../../routines/types.ts';
import { computeRunCapMs, type RunDeps, runCommand } from './run.ts';

/** Recording `CheckpointStore` fake — `nextTimeDir` echoes `time` back
 * (no collision-avoidance needed in these tests); `latestTimeDir` and
 * `readLatest` return the fixed results supplied by `opts` (default
 * `undefined` — "no prior group / no checkpoint found"). */
function fakeCheckpointStore(
  opts: {
    latestTimeDirResult?: string;
    readLatestResult?: { ref: CheckpointRef; payload: unknown };
  } = {},
): {
  store: CheckpointStore;
  nextTimeDirCalls: Array<{ runDate: string; time: string }>;
  latestTimeDirCalls: string[];
} {
  const nextTimeDirCalls: Array<{ runDate: string; time: string }> = [];
  const latestTimeDirCalls: string[] = [];
  const store: CheckpointStore = {
    write() {},
    readLatest() {
      return opts.readLatestResult;
    },
    latestTimeDir(runDate) {
      latestTimeDirCalls.push(runDate);
      return opts.latestTimeDirResult;
    },
    latestCheckpointTimeDir() {
      return undefined; // --resume discovery has its own dedicated tests in run.resume.test.ts
    },
    nextTimeDir(runDate, time) {
      nextTimeDirCalls.push({ runDate, time });
      return time;
    },
    pruneOlderThan() {
      return 0;
    },
    close() {},
  };
  return { store, nextTimeDirCalls, latestTimeDirCalls };
}

function fakeLockDeps(): Pick<RunDeps, 'acquireLock' | 'releaseLock'> {
  return {
    acquireLock: async () => ({ acquired: true }),
    releaseLock: async () => {},
  };
}

function passedResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    profile: 'rajni',
    date: '2026-07-25',
    time: '09-00',
    outcome: 'passed',
    stages: [],
    ...overrides,
  };
}

/** Recording `RunStore` fake — `startRun` auto-increments ids from 1;
 * `findRunId` returns `opts.findRunIdResult` (default `null`, "no prior row
 * on record"). Every write is recorded verbatim for assertions. */
function fakeRunStore(opts: { findRunIdResult?: number | null } = {}): {
  store: RunStore;
  started: Array<Parameters<RunStore['startRun']>[0]>;
  finished: Array<{
    runId: number;
    outcome: 'passed' | 'failed';
    result: unknown;
    finishedAt: string;
  }>;
  findRunIdCalls: Array<{ date: string; timeDir: string }>;
} {
  const started: Array<Parameters<RunStore['startRun']>[0]> = [];
  const finished: Array<{
    runId: number;
    outcome: 'passed' | 'failed';
    result: unknown;
    finishedAt: string;
  }> = [];
  const findRunIdCalls: Array<{ date: string; timeDir: string }> = [];
  let nextId = 1;
  const store: RunStore = {
    startRun(meta) {
      started.push(meta);
      return nextId++;
    },
    appendEvents() {},
    heartbeat() {},
    recordFailure() {},
    recordSyncDryrun() {},
    finishRun(runId, outcome, result, finishedAt) {
      finished.push({ runId, outcome, result, finishedAt });
    },
    listRuns() {
      return [];
    },
    getRun() {
      return null;
    },
    listEvents() {
      return [];
    },
    findRunId(date, timeDir) {
      findRunIdCalls.push({ date, timeDir });
      return opts.findRunIdResult ?? null;
    },
    listRunTimeDirs() {
      return [];
    },
    pruneRunsOlderThan() {
      return 0;
    },
    close() {},
  };
  return { store, started, finished, findRunIdCalls };
}

function fakeCtx(
  notified: NotifyEvent[],
  runStore: RunStore = fakeRunStore().store,
  checkpointStore: CheckpointStore = fakeCheckpointStore().store,
): PipelineCtx {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage: {} as PipelineCtx['storage'],
    config: { settings: {} } as PipelineCtx['config'],
    ports: {} as PipelineCtx['ports'],
    runStore,
    checkpointStore,
    async notify(event: NotifyEvent) {
      notified.push(event);
    },
  };
}

function fakeRoutine(name: string, when: Routine['when'], calls: string[]): Routine {
  return {
    name,
    when,
    async run() {
      calls.push(name);
    },
  };
}

const FAKE_STAGES: Array<StageDef<StagePayload, StagePayload>> = [];

test('runCommand: a passed run sends the digest once, runs pre-run and post-sync routines, and returns 0', async () => {
  const notified: NotifyEvent[] = [];
  const calls: string[] = [];
  const ctx = fakeCtx(notified);
  const routines: Routine[] = [
    fakeRoutine('preflight', 'pre-run', calls),
    fakeRoutine('cleanup', 'post-sync', calls),
  ];

  const code = await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines, checks: [] }),
      runPipeline: async () => passedResult(),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(code, 0);
  assert.equal(notified.length, 1);
  assert.equal(notified[0]?.kind, 'digest');
  assert.deepEqual(calls, ['preflight', 'cleanup']);
});

test('runCommand: a failed run still sends the digest, does NOT run post-sync routines, and returns 1', async () => {
  const notified: NotifyEvent[] = [];
  const calls: string[] = [];
  const ctx = fakeCtx(notified);
  const routines: Routine[] = [
    fakeRoutine('preflight', 'pre-run', calls),
    fakeRoutine('cleanup', 'post-sync', calls),
  ];

  const code = await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines, checks: [] }),
      runPipeline: async () =>
        passedResult({ outcome: 'failed', failedStage: 'extract' }),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(code, 1);
  assert.equal(notified.length, 1);
  assert.equal(notified[0]?.kind, 'digest');
  assert.deepEqual(calls, ['preflight']);
});

test('runCommand: pre-run routines always run before runPipeline is called', async () => {
  const notified: NotifyEvent[] = [];
  const calls: string[] = [];
  const ctx = fakeCtx(notified);
  const routines: Routine[] = [fakeRoutine('preflight', 'pre-run', calls)];

  const code = await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines, checks: [] }),
      runPipeline: async () => {
        assert.deepEqual(calls, ['preflight']);
        return passedResult();
      },
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(code, 0);
});

test('runCommand: --dry-run threads syncDryRun: true into wire()', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  let receivedOverrides: unknown;

  const code = await runCommand(
    { profile: 'rajni', dryRun: true },
    {
      wire: async (_profile, overrides) => {
        receivedOverrides = overrides;
        return { ctx, stages: FAKE_STAGES, routines: [], checks: [] };
      },
      runPipeline: async () => passedResult(),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(receivedOverrides, { syncDryRun: true });
});

test('runCommand: without --dry-run, wire() gets no overrides', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  let receivedOverrides: unknown = 'unset';

  await runCommand(
    { profile: 'rajni' },
    {
      wire: async (_profile, overrides) => {
        receivedOverrides = overrides;
        return { ctx, stages: FAKE_STAGES, routines: [], checks: [] };
      },
      runPipeline: async () => passedResult(),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(receivedOverrides, undefined);
});

test('runCommand: --dry-run makes the digest text reflect the dry run', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);

  await runCommand(
    { profile: 'rajni', dryRun: true },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
      runPipeline: async () => passedResult(),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(notified.length, 1);
  const text = (notified[0] as { text: string }).text;
  assert.match(text, /DRY RUN/);
});

test('runCommand: overrides ctx.logger with a RunStoreLogger before running the pipeline', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  let observedLoggerCtor: string | undefined;

  await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
      runPipeline: async (_stages, runCtx) => {
        observedLoggerCtor = runCtx.logger.constructor.name;
        return passedResult();
      },
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(observedLoggerCtor, 'RunStoreLogger');
});

// --- runs-observability: the driver opens/closes the run row (Task 6) ---

test('runCommand: a passed run opens a "run"-kind runs row and closes it with the passed outcome and the RunResult blob', async () => {
  const notified: NotifyEvent[] = [];
  const { store, started, finished } = fakeRunStore();
  const ctx = fakeCtx(notified, store);
  const result = passedResult();
  const now = new Date('2026-07-25T09:00:00Z');

  const code = await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
      runPipeline: async () => result,
      now: () => now,
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(code, 0);
  assert.equal(started.length, 1);
  assert.equal(started[0]?.kind, 'run');
  assert.equal(started[0]?.date, '2026-07-25');
  // `timeDir` is the LOCAL clock's HH-MM (`formatRunTime`) — computed the
  // same way here rather than hardcoded, so this test is timezone-agnostic.
  assert.equal(started[0]?.timeDir, formatRunTime(now));
  assert.equal(started[0]?.resumedFrom, undefined, 'no --resume ⇒ no resumedFrom');
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.runId, 1);
  assert.equal(finished[0]?.outcome, 'passed');
  assert.deepEqual(finished[0]?.result, result);
});

test('runCommand: a failed run closes its runs row with outcome "failed"', async () => {
  const notified: NotifyEvent[] = [];
  const { store, finished } = fakeRunStore();
  const ctx = fakeCtx(notified, store);

  const code = await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
      runPipeline: async () =>
        passedResult({ outcome: 'failed', failedStage: 'extract' }),
      now: () => new Date('2026-07-25T09:00:00Z'),
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(code, 1);
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.outcome, 'failed');
});

// The --resume group-discovery/resumedFrom tests (including the L18c fix)
// live in `run.resume.test.ts`, split out to stay under the 800-line
// test-file cap.

test('runCommand: flushes the buffered RunStoreLogger events (via ctx.runStore.appendEvents) before releasing the lock, even when runPipeline throws', async () => {
  const notified: NotifyEvent[] = [];
  const order: string[] = [];
  const { store } = fakeRunStore();
  const observedStore: RunStore = {
    ...store,
    appendEvents(runId, events) {
      order.push('appendEvents');
      store.appendEvents(runId, events);
    },
  };
  const ctx = fakeCtx(notified, observedStore);

  await assert.rejects(
    runCommand(
      { profile: 'rajni' },
      {
        wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
        runPipeline: async (_stages, runCtx) => {
          // Buffered (not flushed immediately) — `runLogger.flush()` in the
          // driver's `finally` is what has to drain this before release.
          runCtx.logger.info('about to throw');
          throw new Error('boom');
        },
        now: () => new Date('2026-07-25T09:00:00Z'),
        root: '/fake/root',
        acquireLock: async () => ({ acquired: true }),
        releaseLock: async () => {
          order.push('release');
        },
      },
    ),
  );

  assert.deepEqual(order, ['appendEvents', 'release']);
});

test('runCommand: a profile with invalid settings.logging throws before any stage runs', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  ctx.config = {
    settings: { logging: { ttyLevel: 'loud' } },
  } as unknown as PipelineCtx['config'];
  let runPipelineCalled = false;

  await assert.rejects(
    runCommand(
      { profile: 'rajni' },
      {
        wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
        runPipeline: async () => {
          runPipelineCalled = true;
          return passedResult();
        },
        now: () => new Date('2026-07-25T00:00:00Z'),
        root: '/fake/root',
        ...fakeLockDeps(),
      },
    ),
  );

  assert.equal(runPipelineCalled, false);
});

function fakeCheck(name: string, status: 'ok' | 'warn' | 'red'): DoctorCheck {
  return {
    name,
    async run() {
      return { check: name, status, detail: `${name}: ${status}` };
    },
  };
}

test('runCommand: a red doctor check aborts before any stage runs and returns 1', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  let runPipelineCalled = false;

  const code = await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({
        ctx,
        stages: FAKE_STAGES,
        routines: [],
        checks: [fakeCheck('cdp-reachable', 'red')],
      }),
      runPipeline: async () => {
        runPipelineCalled = true;
        return passedResult();
      },
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(code, 1);
  assert.equal(runPipelineCalled, false);
  assert.equal(notified.length, 0);
});

test('runCommand: warn-only doctor checks do not abort the run', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);

  const code = await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({
        ctx,
        stages: FAKE_STAGES,
        routines: [],
        checks: [fakeCheck('telegram-bot-token', 'warn')],
      }),
      runPipeline: async () => passedResult(),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(code, 0);
});

test('runCommand: derives runCapMs from the wired stages when no override is given', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  const stages: Array<StageDef<StagePayload, StagePayload>> = [
    {
      name: 'a',
      timeoutMs: 1_000,
      retries: 0,
      async run(input) {
        return input;
      },
    },
    {
      name: 'b',
      timeoutMs: 2_000,
      retries: 1,
      async run(input) {
        return input;
      },
    },
  ];
  let receivedOpts: RunnerOptions | undefined;

  await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages, routines: [], checks: [] }),
      runPipeline: async (_stages, _ctx, _group, opts) => {
        receivedOpts = opts;
        return passedResult();
      },
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(receivedOpts?.runCapMs, computeRunCapMs(stages));
  // sanity: (1_000 * 1 + 2_000 * 2) * 1.25 = 6_250
  assert.equal(receivedOpts?.runCapMs, 6_250);
});

test('runCommand: an explicit runCapMs override wins over the derived value', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  let receivedOpts: RunnerOptions | undefined;

  await runCommand(
    { profile: 'rajni', runCapMs: 42_000 },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
      runPipeline: async (_stages, _ctx, _group, opts) => {
        receivedOpts = opts;
        return passedResult();
      },
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(receivedOpts?.runCapMs, 42_000);
});

test('computeRunCapMs: sums timeoutMs * (retries + 1) across stages with margin', () => {
  const stages: Array<StageDef<StagePayload, StagePayload>> = [
    {
      name: 'farm',
      timeoutMs: 5_400_000,
      retries: 0,
      async run(input) {
        return input;
      },
    },
    {
      name: 'structure',
      timeoutMs: 1_800_000,
      retries: 1,
      async run(input) {
        return input;
      },
    },
    {
      name: 'source',
      timeoutMs: 300_000,
      retries: 0,
      async run(input) {
        return input;
      },
    },
    {
      name: 'sync',
      timeoutMs: 900_000,
      retries: 0,
      async run(input) {
        return input;
      },
    },
  ];
  const capMs = computeRunCapMs(stages);
  // worst case: 5_400_000 + 1_800_000*2 + 300_000 + 900_000 = 10_200_000
  // with 1.25 margin: 12_750_000 — comfortably above the sum of single-attempt
  // stage budgets (~8_400_000).
  assert.equal(capMs, 12_750_000);
  assert.ok(capMs > 5_400_000 + 1_800_000 * 2 + 300_000 + 900_000);
});

function fakeHeldBy(overrides: Partial<LockInfo> = {}): LockInfo {
  return {
    pid: 4242,
    profile: 'harish',
    startedAt: '2026-07-25T09:00:00Z',
    ...overrides,
  };
}

test('runCommand: a held run lock skips the run — no stage runs, no digest, returns 1', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  let runPipelineCalled = false;
  let released = false;

  const code = await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
      runPipeline: async () => {
        runPipelineCalled = true;
        return passedResult();
      },
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
      acquireLock: async () => ({ acquired: false, heldBy: fakeHeldBy() }),
      releaseLock: async () => {
        released = true;
      },
    },
  );

  assert.equal(code, 1);
  assert.equal(runPipelineCalled, false);
  // Skip is reported as an 'alert', never a 'digest' (never a bogus passed outcome).
  assert.equal(notified.length, 1);
  assert.equal(notified[0]?.kind, 'alert');
  assert.match((notified[0] as { text: string }).text, /SKIPPED/);
  assert.match((notified[0] as { text: string }).text, /harish/);
  assert.match((notified[0] as { text: string }).text, /4242/);
  // The lock was never acquired by this run, so it must never be released either.
  assert.equal(released, false);
});

test('runCommand: acquires the lock before the doctor preflight and releases it after a passed run', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  const calls: string[] = [];

  const code = await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
      runPipeline: async () => passedResult(),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
      acquireLock: async (profile) => {
        calls.push(`acquire:${profile}`);
        return { acquired: true };
      },
      releaseLock: async () => {
        calls.push('release');
      },
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(calls, ['acquire:rajni', 'release']);
});

test('runCommand: releases the lock even when the doctor preflight aborts the run', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  let released = false;

  const code = await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({
        ctx,
        stages: FAKE_STAGES,
        routines: [],
        checks: [fakeCheck('cdp-reachable', 'red')],
      }),
      runPipeline: async () => passedResult(),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root: '/fake/root',
      acquireLock: async () => ({ acquired: true }),
      releaseLock: async () => {
        released = true;
      },
    },
  );

  assert.equal(code, 1);
  assert.equal(released, true);
});

test('runCommand: releases the lock even when runPipeline throws', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  let released = false;

  await assert.rejects(
    runCommand(
      { profile: 'rajni' },
      {
        wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
        runPipeline: async () => {
          throw new Error('boom');
        },
        now: () => new Date('2026-07-25T00:00:00Z'),
        root: '/fake/root',
        acquireLock: async () => ({ acquired: true }),
        releaseLock: async () => {
          released = true;
        },
      },
    ),
  );

  assert.equal(released, true);
  assert.equal(notified.length, 0);
});
