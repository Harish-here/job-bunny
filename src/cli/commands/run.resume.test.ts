/**
 * run.resume.test.ts (checkpoints-to-db Phase 2 Task 6, split out of
 * run.test.ts to stay under the 800-line test-file cap — mirrors
 * `cli/wire/compose.checkpointstore.test.ts`'s split precedent) — the
 * `--resume` group-discovery/resumedFrom tests, including the L18d fix
 * (`ctx.checkpointStore.latestCheckpointTimeDir`, NOT the union-based
 * `latestTimeDir`: a prior group that is only a bare `runs` row with no
 * checkpoints yet must never shadow an EARLIER group that actually has a
 * checkpoint — resume/chain-continuation always finds the latter, never
 * falls back to a fresh start just because the most recent group happened
 * to die before checkpointing anything). Every dependency is FAKE, same
 * conventions as `run.test.ts`.
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
 * doc comment; kept minimal here since only `latestCheckpointTimeDir`/
 * `readLatest` are exercised by these tests (`run.ts`'s `--resume` discovery
 * never calls the union-based `latestTimeDir`). */
function fakeCheckpointStore(
  opts: {
    latestCheckpointTimeDirResult?: string;
    readLatestResult?: { ref: CheckpointRef; payload: unknown };
  } = {},
): { store: CheckpointStore } {
  const store: CheckpointStore = {
    write() {},
    readLatest() {
      return opts.readLatestResult;
    },
    latestTimeDir() {
      return undefined; // not exercised by run.ts's --resume discovery
    },
    latestCheckpointTimeDir() {
      return opts.latestCheckpointTimeDirResult;
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
    listRunTimeDirs() {
      return [];
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
    stateStore: {} as PipelineCtx['stateStore'],
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
    latestCheckpointTimeDirResult: priorTime,
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

test('runCommand: --resume with no prior same-day checkpointed group never calls findRunId and starts a fresh row with no resumedFrom', async () => {
  const notified: NotifyEvent[] = [];
  const { store, started, findRunIdCalls } = fakeRunStore();
  const { store: checkpointStore } = fakeCheckpointStore({
    latestCheckpointTimeDirResult: undefined,
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

test('runCommand: --resume skips a same-day group that is only a bare runs-row (no checkpoints yet) and resumes the EARLIER checkpointed group instead', async () => {
  // The scenario the L18d fix (`latestCheckpointTimeDir`) closes: 07-00
  // checkpointed through 'rank' and then failed; a first `--resume` at
  // 08-00 continued from it but failed again before writing any checkpoint
  // of its own — 08-00 is now a bare `runs` row. This SECOND `--resume`
  // must discover 07-00 (the last group with an actual payload), never
  // 08-00 — `latestCheckpointTimeDir` itself guarantees this by construction
  // (it only ever returns a time_dir with a real checkpoint row), so this
  // fake never even offers 08-00 as a candidate.
  const date = '2026-07-25';
  const earlierCheckpointedTime = '07-00';
  const notified: NotifyEvent[] = [];
  const { store, started, findRunIdCalls } = fakeRunStore({ findRunIdResult: 42 });
  const { store: checkpointStore } = fakeCheckpointStore({
    latestCheckpointTimeDirResult: earlierCheckpointedTime,
    readLatestResult: {
      ref: {
        runDate: date,
        timeDir: earlierCheckpointedTime,
        position: 6,
        stage: 'rank',
      },
      payload: { jobs: [{ id: 'a' }], dropped: [] },
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
  // The earlier CHECKPOINTED group is resumed — real resumedFrom, not a
  // fresh start.
  assert.deepEqual(findRunIdCalls, [{ date, timeDir: earlierCheckpointedTime }]);
  assert.equal(started.length, 1);
  assert.equal(started[0]?.resumedFrom, 42);
});
