import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { JD, Verdict } from '../../core/jd/index.ts';
import type {
  CheckpointRef,
  CheckpointStore,
  Connector,
  RunFailure,
  RunStore,
  Storage,
} from '../../ports/index.ts';
import type { PipelineCtx, WiredPorts } from './context.ts';
import { runPipeline } from './run.ts';
import type { DroppedRecord, StageDef, StagePayload } from './stage.ts';

function makeJD(id: string): JD {
  return {
    identity: {
      id,
      lane: 'fake-lane',
      url: `https://example.com/${id}`,
      company: 'Acme',
      title: `Job ${id}`,
      scrapedAt: new Date().toISOString(),
    },
  };
}

function makeVerdict(rule: string): Verdict {
  return { rule, severity: 'hard', pass: false };
}

function fakeStorage(): Storage {
  return {
    async readJson() {
      return undefined;
    },
    async writeJson() {},
    async listSubdirs() {
      return [];
    },
    async removeTree() {},
  };
}

function fakeConnector(): Connector {
  return {
    name: 'fake-connector',
    async rebuildCache() {
      return [];
    },
    async syncJobs() {
      return [];
    },
    async archiveStale() {
      return { archived: 0, dropped: [] };
    },
  };
}

function fakePorts(): WiredPorts {
  return { lanes: [], connector: fakeConnector(), notifiers: [] };
}

/** A recording fake `RunStore` — only `heartbeat`/`recordFailure` (the two
 * methods the runner calls) do anything useful; the rest are stubs the
 * runner never touches. */
function fakeRunStore(): {
  store: RunStore;
  heartbeats: string[];
  failures: RunFailure[];
} {
  const heartbeats: string[] = [];
  const failures: RunFailure[] = [];
  const store: RunStore = {
    startRun() {
      return -1;
    },
    appendEvents() {},
    heartbeat(_runId, at) {
      heartbeats.push(at);
    },
    recordFailure(_runId, failure) {
      failures.push(failure);
    },
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
    close() {},
  };
  return { store, heartbeats, failures };
}

/** A recording fake `CheckpointStore` — only `write` (the one method the
 * runner calls) does anything useful; the rest are stubs the runner itself
 * never touches. `throwOn`, when set, makes `write` throw for that
 * checkpoint's `position` — used to test the LOUD write-failure path. */
function fakeCheckpointStore(opts?: { throwOn?: number }): {
  store: CheckpointStore;
  writes: Array<{ ref: CheckpointRef; payload: unknown }>;
} {
  const writes: Array<{ ref: CheckpointRef; payload: unknown }> = [];
  const store: CheckpointStore = {
    write(ref, payload) {
      if (opts?.throwOn === ref.position) {
        throw new Error(`checkpoint write failed at position ${ref.position}`);
      }
      writes.push({ ref, payload });
    },
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
  return { store, writes };
}

function fakeCtx(
  controller: AbortController = new AbortController(),
  overrides: {
    runStore?: RunStore;
    runId?: number;
    checkpointStore?: CheckpointStore;
  } = {},
): {
  ctx: PipelineCtx;
  controller: AbortController;
} {
  const ctx: PipelineCtx = {
    profile: 'rajni',
    signal: controller.signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage: fakeStorage(),
    stateStore: {
      async readDoc() {
        return undefined;
      },
      async writeDoc() {},
      close() {},
    },
    config: {
      lanes: [],
      connector: 'fake-connector',
      notifiers: [],
      routines: [],
      settings: {},
    },
    ports: fakePorts(),
    runStore: overrides.runStore ?? ({} as PipelineCtx['runStore']),
    checkpointStore: overrides.checkpointStore ?? fakeCheckpointStore().store,
    ...(overrides.runId !== undefined ? { runId: overrides.runId } : {}),
    async notify() {},
  };
  return { ctx, controller };
}

function fakeStage(
  overrides: Partial<StageDef<StagePayload, StagePayload>> &
    Pick<StageDef<StagePayload, StagePayload>, 'name' | 'run'>,
): StageDef<StagePayload, StagePayload> {
  return {
    timeoutMs: 1_000,
    retries: 0,
    ...overrides,
  };
}

test('happy path: 3 stages checkpoint, funnel populates, result passes', async () => {
  const group = { date: '2026-07-21', timeDir: '09-00' };
  const { store, heartbeats, failures } = fakeRunStore();
  const { store: checkpointStore, writes } = fakeCheckpointStore();
  const { ctx } = fakeCtx(undefined, { runStore: store, runId: 1, checkpointStore });

  const jobA = makeJD('a');
  const jobC = makeJD('c');
  const droppedB: DroppedRecord = { jd: makeJD('b'), reasons: [makeVerdict('stale')] };

  const farm: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'farm',
    async run(input) {
      return { jobs: [...input.jobs, jobA], dropped: input.dropped };
    },
  });
  const filter: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'filter',
    async run(input) {
      return { jobs: input.jobs, dropped: [...input.dropped, droppedB] };
    },
  });
  const assemble: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'assemble',
    async run(input) {
      return { jobs: [...input.jobs, jobC], dropped: input.dropped };
    },
  });

  const result = await runPipeline([farm, filter, assemble], ctx, group, {
    runCapMs: 5_000,
    stallMs: 5_000,
  });

  assert.equal(result.outcome, 'passed');
  assert.equal(result.failedStage, undefined);
  assert.equal(result.profile, 'rajni');
  assert.equal(result.date, '2026-07-21');
  assert.equal(result.stages.length, 3);

  const [farmResult, filterResult, assembleResult] = result.stages;
  assert.equal(farmResult?.name, 'farm');
  assert.equal(farmResult?.jobsIn, 0);
  assert.equal(farmResult?.jobsOut, 1);
  assert.deepEqual(farmResult?.dropsByRule, {});
  assert.equal(farmResult?.attempts, 1);

  assert.equal(filterResult?.name, 'filter');
  assert.equal(filterResult?.jobsIn, 1);
  assert.equal(filterResult?.jobsOut, 1);
  assert.deepEqual(filterResult?.dropsByRule, { stale: 1 });

  assert.equal(assembleResult?.name, 'assemble');
  assert.equal(assembleResult?.jobsIn, 1);
  assert.equal(assembleResult?.jobsOut, 2);

  for (const stage of result.stages) {
    assert.ok(typeof stage.elapsedMs === 'number' && stage.elapsedMs >= 0);
  }

  // 3 checkpoints written, to the store.
  assert.equal(writes.length, 3);
  assert.equal(writes[0]?.ref.position, 0);
  assert.equal(writes[0]?.ref.stage, 'farm');
  assert.equal(writes[0]?.ref.writtenBy, 1, 'expected ctx.runId to flow into writtenBy');
  const payload0 = writes[0]?.payload as StagePayload;
  assert.equal(payload0.jobs.length, 1);
  assert.equal(writes[1]?.ref.position, 1);
  assert.equal(writes[1]?.ref.stage, 'filter');
  assert.equal(writes[1]?.ref.writtenBy, 1);
  const payload1 = writes[1]?.payload as StagePayload;
  assert.equal(payload1.dropped.length, 1);
  assert.equal(writes[2]?.ref.position, 2);
  assert.equal(writes[2]?.ref.stage, 'assemble');
  assert.equal(writes[2]?.ref.writtenBy, 1);
  const payload2 = writes[2]?.payload as StagePayload;
  assert.equal(payload2.jobs.length, 2);

  // One heartbeat per stage started, no failures recorded on the pass path.
  assert.equal(heartbeats.length, 3);
  assert.equal(failures.length, 0);
});

test('mid-failure: stage 2 throws, stage 3 never runs, result failed but does not throw', async () => {
  const group = { date: '2026-07-21', timeDir: '09-00' };
  const { store, failures } = fakeRunStore();
  const { ctx } = fakeCtx(undefined, { runStore: store, runId: 7 });

  let stage3Called = false;

  const stage1: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'stage1',
    async run(input) {
      return { jobs: [...input.jobs, makeJD('a')], dropped: input.dropped };
    },
  });
  const stage2: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'stage2',
    async run() {
      throw new Error('boom');
    },
  });
  const stage3: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'stage3',
    async run(input) {
      stage3Called = true;
      return input;
    },
  });

  const result = await runPipeline([stage1, stage2, stage3], ctx, group, {
    runCapMs: 5_000,
    stallMs: 5_000,
  });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.failedStage, 'stage2');
  assert.equal(result.stages.length, 1);
  assert.equal(result.stages[0]?.name, 'stage1');
  assert.equal(stage3Called, false);

  assert.equal(failures.length, 1);
  const failure = failures[0];
  assert.equal(failure?.stage, 'stage2');
  assert.ok(typeof failure?.error === 'string' && failure.error.length > 0);
  assert.ok(typeof failure?.elapsedMs === 'number');
});

test("recordFailure's error appends the wrapped cause message", async () => {
  const group = { date: '2026-07-21', timeDir: '09-00' };
  const { store, failures } = fakeRunStore();
  const { ctx } = fakeCtx(undefined, { runStore: store, runId: 3 });

  const stage: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'stage',
    timeoutMs: 1_000,
    retries: 0,
    async run() {
      throw new Error('root cause boom');
    },
  });

  const result = await runPipeline([stage], ctx, group, {
    runCapMs: 5_000,
    stallMs: 5_000,
  });

  assert.equal(result.outcome, 'failed');

  assert.equal(failures.length, 1);
  // guardStage wraps the original throw in `stage "..." failed after N
  // attempt(s)` with `{ cause: <original error> }` — the cause's message
  // must still surface here, not just the wrapper's.
  assert.equal(
    failures[0]?.error,
    'stage "stage" failed after 1 attempt(s) — cause: root cause boom',
  );
});

test('a checkpoint-store write throw fails the run', async () => {
  const group = { date: '2026-07-21', timeDir: '09-00' };
  const { store, failures } = fakeRunStore();
  const { store: checkpointStore } = fakeCheckpointStore({ throwOn: 0 });
  const { ctx } = fakeCtx(undefined, { runStore: store, runId: 9, checkpointStore });

  const stage: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'stage0',
    async run(input) {
      return input;
    },
  });

  const result = await runPipeline([stage], ctx, group, {
    runCapMs: 5_000,
    stallMs: 5_000,
  });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.failedStage, 'stage0');

  assert.equal(failures.length, 1);
  assert.ok(failures[0]?.error.includes('checkpoint write failed at position 0'));
});

test('resume: seeded from an earlier group, fast-forwards past its latest checkpoint, reuses its payload, and writes into its OWN group', async () => {
  const group = { date: '2026-07-21', timeDir: '09-00' };
  const { store: checkpointStore, writes } = fakeCheckpointStore();
  const { ctx } = fakeCtx(undefined, { checkpointStore });

  let stage0Called = false;
  let stage1Input: StagePayload | undefined;

  const checkpointPayload: StagePayload = { jobs: [makeJD('seed')], dropped: [] };

  const stage0: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'stage0',
    async run(input) {
      stage0Called = true;
      return input;
    },
  });
  const stage1: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'stage1',
    async run(input) {
      stage1Input = input;
      return { jobs: [...input.jobs, makeJD('b')], dropped: input.dropped };
    },
  });
  const stage2: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'stage2',
    async run(input) {
      return input;
    },
  });

  const result = await runPipeline([stage0, stage1, stage2], ctx, group, {
    runCapMs: 5_000,
    stallMs: 5_000,
    resumeFrom: {
      startIndex: 1,
      payload: checkpointPayload,
      checkpointPath: '2026-07-21/08-00#0-stage0',
    },
  });

  assert.equal(stage0Called, false);
  assert.deepEqual(stage1Input, checkpointPayload);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.stages.length, 2);
  assert.equal(result.stages[0]?.name, 'stage1');
  assert.equal(result.stages[1]?.name, 'stage2');

  // Checkpoints from the resumed run land in ITS OWN group's timeDir, never
  // the prior one's.
  assert.equal(writes.length, 2);
  for (const write of writes) {
    assert.equal(write.ref.runDate, '2026-07-21');
    assert.equal(write.ref.timeDir, '09-00');
    // ctx.runId is unset in this ctx (no `runId` override passed to
    // fakeCtx) — writtenBy must be omitted entirely, never a sentinel.
    assert.equal(write.ref.writtenBy, undefined);
  }
  assert.equal(writes[0]?.ref.stage, 'stage1');
  const resumedPayload = writes[0]?.payload as StagePayload;
  assert.equal(resumedPayload.jobs.length, 2);
});

test('run-cap: a hanging stage is killed at runCapMs and result is failed (no throw)', async () => {
  const group = { date: '2026-07-21', timeDir: '09-00' };
  const { ctx } = fakeCtx();

  const hanging: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'hanging',
    timeoutMs: 5_000, // per-stage timeout must not be what fires first
    async run() {
      // deliberately ignores its own signal — only the run cap should kill it.
      await delay(2_000);
      return { jobs: [], dropped: [] };
    },
  });

  const started = Date.now();
  const result = await runPipeline([hanging], ctx, group, {
    runCapMs: 40,
    stallMs: 5_000,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.outcome, 'failed');
  assert.equal(result.failedStage, 'hanging');
  assert.ok(elapsed < 500, `expected run-cap kill near 40ms, took ${elapsed}ms`);
});

test('a stage that logs via ctx.logger is handed a logger scoped to its own stage name', async () => {
  const group = { date: '2026-07-21', timeDir: '09-00' };
  const recorded: Array<{ msg: string; data?: Record<string, unknown> }> = [];
  const { ctx } = fakeCtx();
  ctx.logger = {
    debug() {},
    info(msg, data) {
      recorded.push({ msg, data });
    },
    warn() {},
    error() {},
  };

  const stage: StageDef<StagePayload, StagePayload> = fakeStage({
    name: 'scoped-stage',
    async run(input, stageCtx) {
      stageCtx.logger.info('hi');
      return input;
    },
  });

  await runPipeline([stage], ctx, group, { runCapMs: 5_000, stallMs: 5_000 });

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.data?.scope, 'scoped-stage');
});
