/**
 * run.catchup.test.ts (Task 15, split out of run.test.ts to stay under the
 * 800-line test-file cap — mirrors `run.resume.test.ts`'s split precedent)
 * — coverage for `opts.catchupSlots` flowing through `runCommand` into
 * `ctx.runStore.startRun`'s `kind`/`catchupSlots`. Every dependency is
 * FAKE, same conventions as `run.test.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunResult } from '../../ops/observability/index.ts';
import type { PipelineCtx } from '../../pipeline/runner/context.ts';
import type { StageDef, StagePayload } from '../../pipeline/runner/stage.ts';
import type { CheckpointStore } from '../../ports/checkpoint_store.ts';
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

function fakeCheckpointStore(): { store: CheckpointStore } {
  const store: CheckpointStore = {
    write() {},
    readLatest() {
      return undefined;
    },
    latestTimeDir() {
      return undefined;
    },
    latestCheckpointTimeDir() {
      return undefined;
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
 * comment; kept minimal here since only `startRun` is exercised. */
function fakeRunStore(): {
  store: RunStore;
  started: Array<Parameters<RunStore['startRun']>[0]>;
} {
  const started: Array<Parameters<RunStore['startRun']>[0]> = [];
  let nextId = 1;
  const store: RunStore = {
    startRun(meta) {
      started.push(meta);
      return nextId++;
    },
    appendEvents() {},
    heartbeat() {},
    recordProgress() {},
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
    findRunId() {
      return null;
    },
    listRunTimeDirs() {
      return [];
    },
    pruneRunsOlderThan() {
      return 0;
    },
    hasRunOfKind() {
      return false;
    },
    close() {},
  };
  return { store, started };
}

function fakeCtx(notified: NotifyEvent[], runStore: RunStore): PipelineCtx {
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
    checkpointStore: fakeCheckpointStore().store,
    async notify(event: NotifyEvent) {
      notified.push(event);
    },
  };
}

const FAKE_STAGES: Array<StageDef<StagePayload, StagePayload>> = [];

test('runCommand: opts.catchupSlots present ⇒ startRun called with kind "catchup" and the slots', async () => {
  const notified: NotifyEvent[] = [];
  const { store, started } = fakeRunStore();
  const ctx = fakeCtx(notified, store);
  const now = new Date('2026-07-25T09:00:00Z');

  const code = await runCommand(
    { profile: 'rajni', catchupSlots: ['09:00', '11:30'] },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
      runPipeline: async () => passedResult(),
      now: () => now,
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(code, 0);
  assert.equal(started.length, 1);
  assert.equal(started[0]?.kind, 'catchup');
  assert.deepEqual(started[0]?.catchupSlots, ['09:00', '11:30']);
});

test('runCommand: opts.catchupSlots absent ⇒ startRun called with kind "run" and no catchupSlots key', async () => {
  const notified: NotifyEvent[] = [];
  const { store, started } = fakeRunStore();
  const ctx = fakeCtx(notified, store);
  const now = new Date('2026-07-25T09:00:00Z');

  const code = await runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
      runPipeline: async () => passedResult(),
      now: () => now,
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );

  assert.equal(code, 0);
  assert.equal(started.length, 1);
  assert.equal(started[0]?.kind, 'run');
  assert.equal(started[0]?.catchupSlots, undefined);
});
