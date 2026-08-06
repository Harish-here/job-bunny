/**
 * stage.test.ts (P8) — TDD for `stageCommand`. `wire` is FAKE; the
 * `RunFolder` is REAL (rooted at a temp dir) so checkpoint read/write is
 * exercised for real, matching run.test.ts's / reconcile.test.ts's
 * convention.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  formatRunTime,
  RunFolder,
  type RunResult,
  type RunStoreLogger,
} from '../../ops/observability/index.ts';
import type { PipelineCtx } from '../../pipeline/runner/context.ts';
import type { StageDef, StagePayload } from '../../pipeline/runner/stage.ts';
import type { NotifyEvent } from '../../ports/notifier.ts';
import type { RunEventRow, RunFailure, RunStore } from '../../ports/run_store.ts';
import { stageCommand } from './stage.ts';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jb-stage-cmd-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Recording `RunStore` fake — mirrors `run.test.ts`'s `fakeRunStore()`.
 * `startRun` auto-increments ids from 1; every write is recorded verbatim
 * for assertions. */
function fakeStore(): RunStore & {
  started: Array<Parameters<RunStore['startRun']>[0]>;
  events: Array<{ runId: number; events: RunEventRow[] }>;
  failures: Array<{ runId: number; failure: RunFailure }>;
  heartbeats: Array<{ runId: number; at: string }>;
  finished: Array<{
    runId: number;
    outcome: 'passed' | 'failed';
    result: unknown;
    finishedAt: string;
  }>;
} {
  const started: Array<Parameters<RunStore['startRun']>[0]> = [];
  const events: Array<{ runId: number; events: RunEventRow[] }> = [];
  const failures: Array<{ runId: number; failure: RunFailure }> = [];
  const heartbeats: Array<{ runId: number; at: string }> = [];
  const finished: Array<{
    runId: number;
    outcome: 'passed' | 'failed';
    result: unknown;
    finishedAt: string;
  }> = [];
  let nextId = 1;
  return {
    started,
    events,
    failures,
    heartbeats,
    finished,
    startRun(meta) {
      started.push(meta);
      return nextId++;
    },
    appendEvents(runId, evts) {
      events.push({ runId, events: evts });
    },
    heartbeat(runId, at) {
      heartbeats.push({ runId, at });
    },
    recordFailure(runId, failure) {
      failures.push({ runId, failure });
    },
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
    pruneRunsOlderThan() {
      return 0;
    },
    close() {},
  };
}

function fakeCtx(runStore: RunStore = fakeStore()): PipelineCtx {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage: {
      async readJson() {
        return undefined;
      },
      async writeJson() {},
      async listSubdirs() {
        return [];
      },
      async removeTree() {},
    },
    config: { settings: {} } as PipelineCtx['config'],
    ports: {} as PipelineCtx['ports'],
    runStore,
    async notify(_event: NotifyEvent) {},
  };
}

function makeStage(
  name: string,
  run: (input: StagePayload, ctx: PipelineCtx) => Promise<StagePayload>,
): StageDef<StagePayload, StagePayload> {
  return { name, timeoutMs: 5_000, retries: 0, run };
}

test('stageCommand: unknown stage name prints valid names and returns 1 (no throw)', async () => {
  const lines: string[] = [];
  const stages = [
    makeStage('compress', async (i) => i),
    makeStage('assemble', async (i) => i),
  ];

  const code = await stageCommand(
    { profile: 'rajni', stage: 'nope' },
    {
      wire: async () => ({ ctx: fakeCtx(), stages, routines: [], checks: [] }),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root,
      write: (line: string) => lines.push(line),
    },
  );

  assert.equal(code, 1);
  assert.ok(lines[0]?.includes('nope'));
  assert.ok(lines[0]?.includes('compress'));
  assert.ok(lines[0]?.includes('assemble'));
});

test('stageCommand: runs from the empty seed payload when no checkpoint exists, creates a fresh time folder, checkpoints at the real index, prints the funnel line', async () => {
  const profile = `p-${Math.random().toString(36).slice(2)}`;
  const lines: string[] = [];
  let observedInput: StagePayload | undefined;
  const stages = [
    makeStage('reconcile', async (i) => i),
    makeStage('compress', async (i) => {
      observedInput = i;
      return { jobs: [{ id: 'a' }] as never, dropped: [] };
    }),
  ];
  const now = new Date('2026-07-25T00:00:00Z');

  const code = await stageCommand(
    { profile, stage: 'compress' },
    {
      wire: async () => ({ ctx: fakeCtx(), stages, routines: [], checks: [] }),
      now: () => now,
      root,
      write: (line: string) => lines.push(line),
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(observedInput, { jobs: [], dropped: [] });

  // No folder existed today — a fresh one is created at the current local
  // HH-MM, per `formatRunTime`.
  const folder = new RunFolder(
    join(root, 'profiles', profile, 'data'),
    '2026-07-25',
    formatRunTime(now),
  );
  const raw = await readFile(folder.checkpointPath(1, 'compress'), 'utf8');
  assert.deepEqual(JSON.parse(raw), { jobs: [{ id: 'a' }], dropped: [] });

  assert.ok(lines.some((l) => l.startsWith('compress: 0 -> 1')));
});

test('stageCommand: resumes from the latest checkpoint rather than the empty seed', async () => {
  const profile = `p-${Math.random().toString(36).slice(2)}`;
  const folder = new RunFolder(
    join(root, 'profiles', profile, 'data'),
    '2026-07-25',
    '09-00',
  );
  await folder.writeCheckpoint(0, 'reconcile', {
    jobs: [{ id: 'seeded' }],
    dropped: [],
  });

  let observedInput: StagePayload | undefined;
  const stages = [
    makeStage('reconcile', async (i) => i),
    makeStage('compress', async (i) => {
      observedInput = i;
      return i;
    }),
  ];

  const code = await stageCommand(
    { profile, stage: 'compress' },
    {
      wire: async () => ({ ctx: fakeCtx(), stages, routines: [], checks: [] }),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root,
      write: () => {},
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(observedInput, { jobs: [{ id: 'seeded' }], dropped: [] });
});

test("stageCommand: continues in TODAY's existing time folder (not the current formatted time) and writes its new checkpoint there", async () => {
  const profile = `p-${Math.random().toString(36).slice(2)}`;
  const dataDir = join(root, 'profiles', profile, 'data');
  // An earlier folder from today, at a time far from whatever
  // `formatRunTime(now)` would produce right now.
  const earlier = new RunFolder(dataDir, '2026-07-25', '03-17');
  await earlier.writeCheckpoint(0, 'reconcile', { jobs: [], dropped: [] });

  const stages = [
    makeStage('reconcile', async (i) => i),
    makeStage('compress', async (i) => ({
      jobs: [...i.jobs, { id: 'x' }] as never,
      dropped: i.dropped,
    })),
  ];

  const code = await stageCommand(
    { profile, stage: 'compress' },
    {
      wire: async () => ({ ctx: fakeCtx(), stages, routines: [], checks: [] }),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root,
      write: () => {},
    },
  );

  assert.equal(code, 0);
  const raw = await readFile(earlier.checkpointPath(1, 'compress'), 'utf8');
  assert.deepEqual(JSON.parse(raw), { jobs: [{ id: 'x' }], dropped: [] });
});

test('stageCommand: overrides ctx.logger with a RunStoreLogger before running the stage', async () => {
  const profile = `p-${Math.random().toString(36).slice(2)}`;
  const ctx = fakeCtx();
  const stages = [makeStage('compress', async (i) => i)];

  const code = await stageCommand(
    { profile, stage: 'compress' },
    {
      wire: async () => ({ ctx, stages, routines: [], checks: [] }),
      now: () => new Date('2026-07-25T00:00:00Z'),
      root,
      write: () => {},
    },
  );

  assert.equal(code, 0);
  assert.equal(ctx.logger.constructor.name, 'RunStoreLogger');
});

test('stageCommand: hands guardStage a logger scoped to the target stage name', async () => {
  const profile = `p-${Math.random().toString(36).slice(2)}`;
  const store = fakeStore();
  const ctx = fakeCtx(store);
  const stages = [
    makeStage('compress', async (i, stageCtx) => {
      stageCtx.logger.info('hi');
      return i;
    }),
  ];
  const now = new Date('2026-07-25T00:00:00Z');

  const code = await stageCommand(
    { profile, stage: 'compress' },
    {
      wire: async () => ({ ctx, stages, routines: [], checks: [] }),
      now: () => now,
      root,
      write: () => {},
    },
  );

  assert.equal(code, 0);
  // stageCommand unconditionally replaces `ctx.logger` with a real
  // RunStoreLogger (pinned by the assignment test above), so a fake-logger
  // spy injected here would be clobbered. The scope wrapping is asserted by
  // flushing the buffered events out to the fake store and inspecting the
  // batch it received, mirroring the old run.log-reading assertion.
  (ctx.logger as RunStoreLogger).flush();
  const line = store.events.flatMap((c) => c.events).find((e) => e.msg === 'hi');
  assert.equal(line?.data?.scope, 'compress');
});

test('stageCommand: opens a "stage" runs row and finishes it as passed with the funnel', async () => {
  const profile = `p-${Math.random().toString(36).slice(2)}`;
  const store = fakeStore();
  const ctx = fakeCtx(store);
  const stages = [
    makeStage('compress', async () => ({ jobs: [{ id: 'a' }] as never, dropped: [] })),
  ];
  const now = new Date('2026-07-25T00:00:00Z');

  const code = await stageCommand(
    { profile, stage: 'compress' },
    {
      wire: async () => ({ ctx, stages, routines: [], checks: [] }),
      now: () => now,
      root,
      write: () => {},
    },
  );

  assert.equal(code, 0);
  assert.equal(store.started.length, 1);
  assert.equal(store.started[0]?.kind, 'stage');
  assert.equal(store.started[0]?.timeDir, formatRunTime(now));

  assert.equal(store.finished.length, 1);
  const finished = store.finished[0];
  assert.equal(finished?.runId, store.started.length); // the id startRun returned
  assert.equal(finished?.outcome, 'passed');
  const result = finished?.result as RunResult;
  assert.equal(result.outcome, 'passed');
  assert.equal(result.profile, 'rajni');
  assert.equal(result.stages[0]?.name, 'compress');
  assert.equal(result.stages[0]?.jobsIn, 0);
  assert.equal(result.stages[0]?.jobsOut, 1);
});

test('stageCommand: heartbeats promptly after startRun, so a long-running stage never shows a NULL heartbeat_at', async () => {
  const profile = `p-${Math.random().toString(36).slice(2)}`;
  const store = fakeStore();
  const ctx = fakeCtx(store);
  const stages = [
    makeStage('compress', async () => ({ jobs: [{ id: 'a' }] as never, dropped: [] })),
  ];
  const now = new Date('2026-07-25T00:00:00Z');

  const code = await stageCommand(
    { profile, stage: 'compress' },
    {
      wire: async () => ({ ctx, stages, routines: [], checks: [] }),
      now: () => now,
      root,
      write: () => {},
    },
  );

  assert.equal(code, 0);
  assert.equal(store.started.length, 1);
  const startedRunId = store.started.length; // the id startRun returned
  assert.ok(
    store.heartbeats.some((h) => h.runId === startedRunId),
    'expected at least one heartbeat for the started run id',
  );
});

test('stageCommand: a stage that throws records the failure, finishes the row as failed, and rethrows', async () => {
  const profile = `p-${Math.random().toString(36).slice(2)}`;
  const store = fakeStore();
  const ctx = fakeCtx(store);
  const stages = [
    makeStage('compress', async () => {
      throw new Error('boom');
    }),
  ];

  // The rethrown error is guardStage's own wrapper (its `cause` carries the
  // underlying "boom") — asserted generically here; the recorded
  // `RunFailure.error` below is what preserves the underlying message.
  await assert.rejects(() =>
    stageCommand(
      { profile, stage: 'compress' },
      {
        wire: async () => ({ ctx, stages, routines: [], checks: [] }),
        now: () => new Date('2026-07-25T00:00:00Z'),
        root,
        write: () => {},
      },
    ),
  );

  assert.equal(store.failures.length, 1);
  assert.equal(store.failures[0]?.failure.stage, 'compress');
  assert.match(store.failures[0]?.failure.error ?? '', /boom/);

  assert.equal(store.finished.length, 1);
  const finished = store.finished[0];
  assert.equal(finished?.outcome, 'failed');
  const result = finished?.result as RunResult;
  assert.equal(result.outcome, 'failed');
  assert.equal(result.failedStage, 'compress');
  assert.deepEqual(result.stages, []);
});

test('stageCommand: a profile with invalid settings.logging throws before the stage runs', async () => {
  const profile = `p-${Math.random().toString(36).slice(2)}`;
  const ctx = fakeCtx();
  ctx.config = {
    settings: { logging: { ttyLevel: 'loud' } },
  } as unknown as PipelineCtx['config'];
  let stageRan = false;
  const stages = [
    makeStage('compress', async (i) => {
      stageRan = true;
      return i;
    }),
  ];

  await assert.rejects(() =>
    stageCommand(
      { profile, stage: 'compress' },
      {
        wire: async () => ({ ctx, stages, routines: [], checks: [] }),
        now: () => new Date('2026-07-25T00:00:00Z'),
        root,
        write: () => {},
      },
    ),
  );

  assert.equal(stageRan, false);
});
