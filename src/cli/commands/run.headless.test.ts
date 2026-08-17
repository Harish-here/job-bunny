/**
 * run.headless.test.ts (launcher flag registry + --headless wiring packet)
 * — the `--headless` -> `wire()` overrides threading tests, split out of
 * `run.test.ts` to stay under its 800-line test-file cap (mirrors
 * `run.resume.test.ts`'s split precedent). Every dependency is FAKE, same
 * conventions as `run.test.ts`.
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

function fakeRunStore(): RunStore {
  let nextId = 1;
  return {
    startRun() {
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
}

function fakeCheckpointStore(): CheckpointStore {
  return {
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
}

function fakeCtx(notified: NotifyEvent[]): PipelineCtx {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage: {} as PipelineCtx['storage'],
    stateStore: {} as PipelineCtx['stateStore'],
    config: { settings: {} } as PipelineCtx['config'],
    ports: {} as PipelineCtx['ports'],
    runStore: fakeRunStore(),
    checkpointStore: fakeCheckpointStore(),
    async notify(event: NotifyEvent) {
      notified.push(event);
    },
  };
}

const FAKE_STAGES: Array<StageDef<StagePayload, StagePayload>> = [];

test('runCommand: --headless threads headless: true into wire()', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  let receivedOverrides: unknown;

  const code = await runCommand(
    { profile: 'rajni', headless: true },
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
  assert.deepEqual(receivedOverrides, { headless: true });
});

test('runCommand: an explicit --headless=false threads no overrides into wire()', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  let receivedOverrides: unknown;

  await runCommand(
    { profile: 'rajni', headless: false },
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

test('runCommand: --headless and --dry-run together thread both overrides into wire()', async () => {
  const notified: NotifyEvent[] = [];
  const ctx = fakeCtx(notified);
  let receivedOverrides: unknown;

  await runCommand(
    { profile: 'rajni', headless: true, dryRun: true },
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

  assert.deepEqual(receivedOverrides, { syncDryRun: true, headless: true });
});
