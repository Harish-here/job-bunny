/**
 * run.resume.test.ts (checkpoints-to-db Phase 2 Task 6, split out of
 * run.test.ts to stay under the 800-line test-file cap — mirrors
 * `cli/wire/compose.checkpointstore.test.ts`'s split precedent) — the
 * `--resume` group-discovery/resumedFrom tests, including the L18c fix
 * ("a prior group that is only a bare `runs` row with no checkpoints yet
 * must start this run fresh, not report a bogus resumedFrom"). Every
 * dependency is FAKE, same conventions as `run.test.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunResult } from '../../ops/observability/index.ts';
import type { PipelineCtx } from '../../pipeline/runner/context.ts';
import type { StageDef, StagePayload } from '../../pipeline/runner/stage.ts';
import type { CheckpointRef, CheckpointStore } from '../../ports/checkpoint_store.ts';
import type { NotifyEvent } from '../../ports/notifier.ts';
import type { RunStore } from '../../ports/run_store.ts';
import type { RunDeps } from './run.ts';
import { runCommand } from './run.ts';

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

/** Recording `CheckpointStore` fake — see `run.test.ts`'s twin for the full
 * doc comment; kept minimal here since only `latestTimeDir`/`readLatest`
 * are exercised by these tests. */
function fakeCheckpointStore(
  opts: {
    latestTimeDirResult?: string;
    readLatestResult?: { ref: CheckpointRef; payload: unknown };
  } = {},
): { store: CheckpointStore } {
  const store: CheckpointStore = {
    write() {},
    readLatest() {
      return opts.readLatestResult;
    },
    latestTimeDir() {
      return opts.latestTimeDirResult;
    },
    nextTimeDir(_runDate, time) {
      return time;
    },
    pruneOlderThan() {
      return 0;
    },
    close() {},
  };
  return { store };
}

/** Recording `RunStore` fake — see `run.test.ts`'s twin for the full doc
 * comment. */
function fakeRunStore(opts: { findRunIdResult?: number | null } = {}): {
  store: RunStore;
  started: Array<Parameters<RunStore['startRun']>[0]>;
  findRunIdCalls: Array<{ date: string; timeDir: string }>;
} {
  const started: Array<Parameters<RunStore['startRun']>[0]> = [];
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
    finishRun() {},
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
    pruneRunsOlderThan() {
      return 0;
    },
    close() {},
  };
  return { store, started, findRunIdCalls };
}

function fakeCtx(
  notified: NotifyEvent[],
  runStore: RunStore,
  checkpointStore: CheckpointStore,
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

const FAKE_STAGES: Array<StageDef<StagePayload, StagePayload>> = [];

test('runCommand: --resume, with a prior same-day checkpoint on disk, passes resumedFrom from runStore.findRunId', async () => {
  const date = '2026-07-25';
  const priorTime = '08-00';
  const notified: NotifyEvent[] = [];
  const { store, started, findRunIdCalls } = fakeRunStore({ findRunIdResult: 42 });
  const { store: checkpointStore } = fakeCheckpointStore({
    latestTimeDirResult: priorTime,
    readLatestResult: {
      ref: { runDate: date, timeDir: priorTime, position: 0, stage: 'farm' },
      payload: { jobs: [], dropped: [] },
    },
  });
  const ctx = fakeCtx(notified, store, checkpointStore);

  const code = await runCommand(
    { profile: 'rajni', resume: true },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
      runPipeline: async () => passedResult(),
      now: () => new Date('2026-07-25T09:00:00Z'),
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(findRunIdCalls, [{ date, timeDir: priorTime }]);
  assert.equal(started.length, 1);
  assert.equal(started[0]?.resumedFrom, 42);
});

test('runCommand: --resume with no prior same-day folder never calls findRunId and starts a fresh row with no resumedFrom', async () => {
  const notified: NotifyEvent[] = [];
  const { store, started, findRunIdCalls } = fakeRunStore();
  const { store: checkpointStore } = fakeCheckpointStore({
    latestTimeDirResult: undefined,
  });
  const ctx = fakeCtx(notified, store, checkpointStore);

  const code = await runCommand(
    { profile: 'rajni', resume: true },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
      runPipeline: async () => passedResult(),
      now: () => new Date('2026-07-25T09:00:00Z'),
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(findRunIdCalls, []);
  assert.equal(started.length, 1);
  assert.equal(started[0]?.resumedFrom, undefined);
});

test('runCommand: --resume when the prior group is a runs-row with no checkpoints yet starts fresh with no resumedFrom', async () => {
  const priorTime = '08-00';
  const notified: NotifyEvent[] = [];
  const { store, started, findRunIdCalls } = fakeRunStore({ findRunIdResult: 42 });
  const { store: checkpointStore } = fakeCheckpointStore({
    latestTimeDirResult: priorTime,
    readLatestResult: undefined,
  });
  const ctx = fakeCtx(notified, store, checkpointStore);

  const code = await runCommand(
    { profile: 'rajni', resume: true },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
      runPipeline: async () => passedResult(),
      now: () => new Date('2026-07-25T09:00:00Z'),
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(code, 0);
  // The exact behavior being fixed (L18c): a discovered prior time_dir with
  // no checkpoint yet must never resolve to a bogus resumedFrom.
  assert.deepEqual(findRunIdCalls, []);
  assert.equal(started.length, 1);
  assert.equal(started[0]?.resumedFrom, undefined);
});
