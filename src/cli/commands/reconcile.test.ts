/**
 * reconcile.test.ts (P8) — TDD for `reconcileCommand`. Every dependency
 * (`wire`, `runPipeline`, `now`, `runStore`, `checkpointStore`) is FAKE — a
 * temp dir is still allocated for `root` (part of `ReconcileDeps`'s
 * surface), but nothing in this file touches the real filesystem for group
 * discovery anymore — that's `ctx.checkpointStore.latestCheckpointTimeDir`
 * now.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { RunResult } from '../../ops/observability/index.ts';
import type { PipelineCtx } from '../../pipeline/runner/context.ts';
import type { StageDef, StagePayload } from '../../pipeline/runner/stage.ts';
import type { CheckpointStore } from '../../ports/checkpoint_store.ts';
import type { NotifyEvent } from '../../ports/notifier.ts';
import type { RunStore } from '../../ports/run_store.ts';
import type { Storage } from '../../ports/storage.ts';
import { reconcileCommand } from './reconcile.ts';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jb-reconcile-cmd-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function passedResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    profile: 'rajni',
    date: '2026-07-25',
    time: '09-00',
    outcome: 'passed',
    stages: [
      {
        name: 'reconcile',
        elapsedMs: 1,
        attempts: 1,
        jobsIn: 0,
        jobsOut: 0,
        dropsByRule: {},
      },
    ],
    ...overrides,
  };
}

function fakeStorage(store: Map<string, unknown>): Storage {
  return {
    async readJson<T>(relPath: string, schema: { parse(v: unknown): T }) {
      if (!store.has(relPath)) return undefined;
      return schema.parse(store.get(relPath));
    },
    async writeJson(relPath: string, value: unknown) {
      store.set(relPath, value);
    },
    async listSubdirs() {
      return [];
    },
    async removeTree() {},
  };
}

/** Recording `RunStore` fake — mirrors `run.test.ts`'s `fakeRunStore()`.
 * `startRun` auto-increments ids from 1; every write is recorded verbatim
 * for assertions. */
function fakeRunStore(): {
  store: RunStore;
  started: Array<Parameters<RunStore['startRun']>[0]>;
  finished: Array<{
    runId: number;
    outcome: 'passed' | 'failed';
    result: unknown;
    finishedAt: string;
  }>;
} {
  const started: Array<Parameters<RunStore['startRun']>[0]> = [];
  const finished: Array<{
    runId: number;
    outcome: 'passed' | 'failed';
    result: unknown;
    finishedAt: string;
  }> = [];
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
    findRunId() {
      return null;
    },
    listRunTimeDirs() {
      return [];
    },
    pruneRunsOlderThan() {
      return 0;
    },
    close() {},
  };
  return { store, started, finished };
}

/** Minimal recording `CheckpointStore` fake — `reconcileCommand` only ever
 * calls `latestCheckpointTimeDir` (never `write`/`readLatest`/
 * `nextTimeDir`/`latestTimeDir`); default `undefined` ("no prior
 * checkpointed group today"). */
function fakeCheckpointStore(
  latestCheckpointTimeDirResult: string | undefined = undefined,
): {
  store: CheckpointStore;
  latestCheckpointTimeDirCalls: string[];
} {
  const latestCheckpointTimeDirCalls: string[] = [];
  const store: CheckpointStore = {
    write() {},
    readLatest() {
      return undefined;
    },
    latestTimeDir() {
      return undefined; // not exercised by reconcileCommand
    },
    latestCheckpointTimeDir(runDate) {
      latestCheckpointTimeDirCalls.push(runDate);
      return latestCheckpointTimeDirResult;
    },
    nextTimeDir(_runDate, time) {
      return time;
    },
    pruneOlderThan() {
      return 0;
    },
    close() {},
  };
  return { store, latestCheckpointTimeDirCalls };
}

function fakeCtx(
  store: Map<string, unknown>,
  runStore: RunStore = fakeRunStore().store,
  checkpointStore: CheckpointStore = fakeCheckpointStore().store,
): PipelineCtx {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage: fakeStorage(store),
    config: { settings: {} } as PipelineCtx['config'],
    ports: {} as PipelineCtx['ports'],
    runStore,
    checkpointStore,
    async notify(_event: NotifyEvent) {},
  };
}

const reconcileStage: StageDef<StagePayload, StagePayload> = {
  name: 'reconcile',
  timeoutMs: 1000,
  retries: 0,
  async run(input) {
    return input;
  },
};

const otherStage: StageDef<StagePayload, StagePayload> = {
  name: 'compress',
  timeoutMs: 1000,
  retries: 0,
  async run(input) {
    return input;
  },
};

test('reconcileCommand: finds the reconcile stage by name, not by array index', async () => {
  const store = new Map<string, unknown>();
  const ctx = fakeCtx(store);
  let observedStages: Array<StageDef<StagePayload, StagePayload>> | undefined;

  const code = await reconcileCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({
        ctx,
        stages: [otherStage, reconcileStage],
        routines: [],
        checks: [],
      }),
      runPipeline: async (stages) => {
        observedStages = stages;
        return passedResult();
      },
      now: () => new Date('2026-07-25T00:00:00Z'),
      root,
      write: () => {},
    },
  );

  assert.equal(code, 0);
  assert.equal(observedStages?.length, 1);
  assert.equal(observedStages?.[0]?.name, 'reconcile');
});

test('reconcileCommand: opens a "reconcile" runs row and finishes it with runPipeline\'s own result', async () => {
  const store = new Map<string, unknown>();
  const { store: runStore, started, finished } = fakeRunStore();
  const ctx = fakeCtx(store, runStore);
  const now = new Date('2026-07-25T00:00:00Z');
  let observedRunId: number | undefined;

  const code = await reconcileCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: [reconcileStage], routines: [], checks: [] }),
      runPipeline: async (_stages, runCtx) => {
        observedRunId = runCtx.runId;
        return passedResult();
      },
      now: () => now,
      root,
      write: () => {},
    },
  );

  assert.equal(code, 0);
  assert.equal(started.length, 1);
  assert.equal(started[0]?.kind, 'reconcile');
  assert.equal(observedRunId, started.length); // the id startRun returned

  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.runId, observedRunId);
  assert.equal(finished[0]?.outcome, 'passed');
  assert.deepEqual(finished[0]?.result, passedResult());
});

test("reconcileCommand: a failed runPipeline result finishes the row as failed (recordFailure is runPipeline's own job)", async () => {
  const store = new Map<string, unknown>();
  const { store: runStore, finished } = fakeRunStore();
  const ctx = fakeCtx(store, runStore);
  const failed = passedResult({
    outcome: 'failed',
    failedStage: 'reconcile',
    stages: [],
  });

  const code = await reconcileCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: [reconcileStage], routines: [], checks: [] }),
      runPipeline: async () => failed,
      now: () => new Date('2026-07-25T00:00:00Z'),
      root,
      write: () => {},
    },
  );

  assert.equal(code, 1);
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.outcome, 'failed');
  assert.deepEqual(finished[0]?.result, failed);
});

test('reconcileCommand: prints the rebuilt cache entry count and returns 0 on success', async () => {
  const store = new Map<string, unknown>([
    [
      'cache/entries.json',
      [
        { id: 'li-1', company: 'Acme', title: 'Engineer', pageId: 'page-1' },
        { id: 'li-2', company: 'Acme', title: 'Designer', pageId: 'page-2' },
      ],
    ],
  ]);
  const ctx = fakeCtx(store);
  const lines: string[] = [];

  const code = await reconcileCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: [reconcileStage], routines: [], checks: [] }),
      runPipeline: async () => passedResult(),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root,
      write: (line: string) => lines.push(line),
    },
  );

  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes('reconcile') && l.includes('2 entries')));
});

test('reconcileCommand: a failed outcome prints the failure and returns 1', async () => {
  const store = new Map<string, unknown>();
  const ctx = fakeCtx(store);
  const lines: string[] = [];

  const code = await reconcileCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: [reconcileStage], routines: [], checks: [] }),
      runPipeline: async () =>
        passedResult({ outcome: 'failed', failedStage: 'reconcile', stages: [] }),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root,
      write: (line: string) => lines.push(line),
    },
  );

  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes('failed')));
});

test('reconcileCommand: overrides ctx.logger with a RunStoreLogger before running the pipeline', async () => {
  const store = new Map<string, unknown>();
  const ctx = fakeCtx(store);
  let observedLoggerCtor: string | undefined;

  const code = await reconcileCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: [reconcileStage], routines: [], checks: [] }),
      runPipeline: async (_stages, runCtx) => {
        observedLoggerCtor = runCtx.logger.constructor.name;
        return passedResult();
      },
      now: () => new Date('2026-07-25T00:00:00Z'),
      root,
      write: () => {},
    },
  );

  assert.equal(code, 0);
  assert.equal(observedLoggerCtor, 'RunStoreLogger');
});

test('reconcileCommand: a profile with invalid settings.logging throws before any stage runs', async () => {
  const store = new Map<string, unknown>();
  const ctx = fakeCtx(store);
  ctx.config = {
    settings: { logging: { ttyLevel: 'loud' } },
  } as unknown as PipelineCtx['config'];
  let runPipelineCalled = false;

  await assert.rejects(() =>
    reconcileCommand(
      { profile: 'rajni' },
      {
        wire: async () => ({ ctx, stages: [reconcileStage], routines: [], checks: [] }),
        runPipeline: async () => {
          runPipelineCalled = true;
          return passedResult();
        },
        now: () => new Date('2026-07-25T00:00:00Z'),
        root,
        write: () => {},
      },
    ),
  );

  assert.equal(runPipelineCalled, false);
});

test('reconcileCommand: continues in an existing prior group discovered via ctx.checkpointStore.latestCheckpointTimeDir, rather than a freshly-formatted time', async () => {
  const store = new Map<string, unknown>();
  const { store: checkpointStore, latestCheckpointTimeDirCalls } =
    fakeCheckpointStore('08-00');
  const ctx = fakeCtx(store, fakeRunStore().store, checkpointStore);
  const now = new Date('2026-07-25T09:00:00Z');
  let observedGroup: { date: string; timeDir: string } | undefined;

  const code = await reconcileCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: [reconcileStage], routines: [], checks: [] }),
      runPipeline: async (_stages, _ctx, group) => {
        observedGroup = group;
        return passedResult();
      },
      now: () => now,
      root,
      write: () => {},
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(latestCheckpointTimeDirCalls, ['2026-07-25']);
  assert.deepEqual(observedGroup, { date: '2026-07-25', timeDir: '08-00' });
});

test('reconcileCommand: throws when wire() lacks a "reconcile" stage', async () => {
  const store = new Map<string, unknown>();
  const ctx = fakeCtx(store);

  await assert.rejects(
    () =>
      reconcileCommand(
        { profile: 'rajni' },
        {
          wire: async () => ({ ctx, stages: [otherStage], routines: [], checks: [] }),
          runPipeline: async () => passedResult(),
          now: () => new Date('2026-07-25T00:00:00Z'),
          root,
          write: () => {},
        },
      ),
    /"reconcile" stage/,
  );
});
