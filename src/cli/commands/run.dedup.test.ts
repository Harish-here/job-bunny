/**
 * run.dedup.test.ts (stability-hardening 1.16, split out of `run.test.ts`
 * to stay under the 800-line test-file cap — mirrors `run.resume.test.ts`/
 * `run.catchup.test.ts`'s own split precedent) — end-to-end proof that
 * `runCommand`'s `'failed'`-outcome notify path (D3 — R17-R20) is wired to
 * `decideNotification`/`composeFailureNotice`/`ctx.stateStore` correctly,
 * through `run.ts`'s own call site (not just at the pure-function level —
 * `run_failure_notice.test.ts` covers that).
 *
 * A `stateStore` fake is threaded across MULTIPLE `runCommand` invocations
 * sharing one persisted doc (mirrors a real profile's dedup state
 * surviving across runs) — every other dependency is fresh/fake per call,
 * same conventions as `run.test.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DedupState, RunResult } from '../../ops/observability/index.ts';
import type { PipelineCtx } from '../../pipeline/runner/context.ts';
import type { StageDef, StagePayload } from '../../pipeline/runner/stage.ts';
import type { CheckpointStore } from '../../ports/checkpoint_store.ts';
import type { NotifyEvent } from '../../ports/notifier.ts';
import type { RunDetail, RunStore } from '../../ports/run_store.ts';
import type { StateStore } from '../../ports/state_store.ts';
import type { RunDeps } from './run.ts';
import { runCommand } from './run.ts';

function fakeLockDeps(): Pick<RunDeps, 'acquireLock' | 'releaseLock'> {
  return {
    acquireLock: async () => ({ acquired: true }),
    releaseLock: async () => {},
  };
}

function failedResult(failedStage: string): RunResult {
  return {
    profile: 'rajni',
    date: '2026-08-11',
    time: '15-49',
    outcome: 'failed',
    failedStage,
    stages: [],
  };
}

function passedResult(): RunResult {
  return {
    profile: 'rajni',
    date: '2026-08-11',
    time: '15-49',
    outcome: 'passed',
    stages: [],
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

function fakeRunDetail(failure: unknown): RunDetail {
  return {
    id: 1,
    date: '2026-08-11',
    timeDir: '15-49',
    kind: 'run',
    resumedFrom: null,
    status: 'failed',
    startedAt: '2026-08-11T15:49:00.000Z',
    finishedAt: '2026-08-11T15:50:00.000Z',
    heartbeatAt: null,
    progress: null,
    catchupSlots: null,
    result: null,
    failure,
    syncDryrun: null,
  };
}

/** `failureRef.current` (set fresh before each `runCommand` call) is what
 * `ctx.runStore.getRun(runId)` returns as `.failure` — the RunFailure-
 * shaped blob `sendFailureDigest` reads back (never threaded through
 * `RunResult`, AC8). */
function fakeRunStore(failureRef: { current: unknown }): { store: RunStore } {
  let nextId = 1;
  const store: RunStore = {
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
      return failureRef.current === undefined ? null : fakeRunDetail(failureRef.current);
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
  return { store };
}

/** Persists ONE doc across however many `readDoc`/`writeDoc` calls this
 * fake sees — real cross-run dedup state, not reset between `runCommand`
 * invocations that share this same fake instance. */
function fakeStateStore(opts: { writeShouldThrow?: boolean } = {}): {
  store: StateStore;
  reads: string[];
  writes: Array<{ key: string; value: unknown }>;
} {
  let doc: unknown;
  const reads: string[] = [];
  const writes: Array<{ key: string; value: unknown }> = [];
  const store: StateStore = {
    async readDoc(key) {
      reads.push(key);
      return doc as never;
    },
    async writeDoc(key, value) {
      writes.push({ key, value });
      if (opts.writeShouldThrow) throw new Error('disk full');
      doc = value;
    },
    close() {},
  };
  return { store, reads, writes };
}

function fakeCtx(
  notified: NotifyEvent[],
  runStore: RunStore,
  stateStore: StateStore,
): PipelineCtx {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
    storage: {} as PipelineCtx['storage'],
    stateStore,
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

function run(ctx: PipelineCtx, result: RunResult, now: Date): Promise<number> {
  return runCommand(
    { profile: 'rajni' },
    {
      wire: async () => ({ ctx, stages: FAKE_STAGES, routines: [], checks: [] }),
      runPipeline: async () => result,
      now: () => now,
      root: '/fake/root',
      ...fakeLockDeps(),
    },
  );
}

const T0 = new Date('2026-08-11T15:49:00.000Z');
const PLUS_1H = new Date(T0.getTime() + 60 * 60_000);
const PLUS_25H = new Date(T0.getTime() + 25 * 60 * 60_000);

/** `writes[i].value` as a `DedupState`, asserting the entry actually
 * exists first — avoids unsafe optional chaining into a cast. */
function writeStateAt(
  writes: Array<{ key: string; value: unknown }>,
  i: number,
): DedupState {
  const entry = writes[i];
  assert.ok(entry, `expected a writeDoc call at index ${i}`);
  return entry.value as DedupState;
}

test('AC16: two failures with the same signature within 24h — first sends, second is suppressed; writeDoc runs both times; a third past 24h reminds', async () => {
  const notified: NotifyEvent[] = [];
  const { store: stateStore, writes } = fakeStateStore();
  const failureRef = {
    current: { stage: 'farm', error: 'stalled: no beat() within 360000ms' },
  };
  const { store: runStore } = fakeRunStore(failureRef);
  const ctx = fakeCtx(notified, runStore, stateStore);

  const code1 = await run(ctx, failedResult('farm'), T0);
  assert.equal(code1, 1);
  assert.equal(notified.length, 1, 'first failure always sends');
  assert.equal(writes.length, 1);
  assert.equal(writeStateAt(writes, 0).consecutiveCount, 1);

  // Same stage, same underlying cause (different elapsed ms — a volatile
  // substring `normalizeFailureText` must collapse) — well within 24h.
  failureRef.current = { stage: 'farm', error: 'stalled: no beat() within 420000ms' };
  const code2 = await run(ctx, failedResult('farm'), PLUS_1H);
  assert.equal(code2, 1);
  assert.equal(notified.length, 1, 'second (same-signature, <24h) failure is suppressed');
  assert.equal(
    writes.length,
    2,
    'writeDoc still runs on suppress, to keep the count current',
  );
  assert.equal(writeStateAt(writes, 1).consecutiveCount, 2);

  // Past 24h since the first send — the once-a-day reminder.
  const code3 = await run(ctx, failedResult('farm'), PLUS_25H);
  assert.equal(code3, 1);
  assert.equal(notified.length, 2, 'the 24h-later reminder sends again');
  assert.equal(writes.length, 3);
  assert.equal(writeStateAt(writes, 2).consecutiveCount, 3);
  const remindText = (notified[1] as { text: string }).text;
  assert.match(remindText, /STILL FAILING \(x3\)/);
});

test('AC17: a different signature while a prior one is (would be) suppressed sends immediately, with the T3 wrapper text', async () => {
  const notified: NotifyEvent[] = [];
  const { store: stateStore } = fakeStateStore();
  const failureRef = {
    current: { stage: 'farm', error: 'stalled: no beat() within 360000ms' },
  };
  const { store: runStore } = fakeRunStore(failureRef);
  const ctx = fakeCtx(notified, runStore, stateStore);

  await run(ctx, failedResult('farm'), T0); // send
  const code2 = await run(ctx, failedResult('farm'), PLUS_1H); // same sig, suppress
  assert.equal(code2, 1);
  assert.equal(notified.length, 1);

  // A genuinely DIFFERENT failure at the SAME stage — must break through.
  failureRef.current = { stage: 'farm', error: 'HTTP 429 from greenhouse' };
  const code3 = await run(ctx, failedResult('farm'), PLUS_1H);
  assert.equal(code3, 1);
  assert.equal(notified.length, 2, 'a new signature always breaks through');
  const text = (notified[1] as { text: string }).text;
  assert.match(text, /NEW FAILURE/);
  assert.match(text, /DIFFERENT failure/);
  assert.match(text, /STILL OPEN/);
});

test('AC18: a passing run while a failure signature is suppressed still sends its digest, bypassing dedup entirely', async () => {
  const notified: NotifyEvent[] = [];
  const { store: stateStore, reads, writes } = fakeStateStore();
  const failureRef = {
    current: { stage: 'farm', error: 'stalled: no beat() within 360000ms' },
  };
  const { store: runStore } = fakeRunStore(failureRef);
  const ctx = fakeCtx(notified, runStore, stateStore);

  await run(ctx, failedResult('farm'), T0); // send
  await run(ctx, failedResult('farm'), PLUS_1H); // suppress
  assert.equal(notified.length, 1);
  const readsSoFar = reads.length;
  const writesSoFar = writes.length;

  const code3 = await run(ctx, passedResult(), PLUS_1H);
  assert.equal(code3, 0);
  assert.equal(notified.length, 2, 'the passing run still sends its digest');
  assert.equal(
    reads.length,
    readsSoFar,
    'readDoc/decideNotification are never invoked for a passing run',
  );
  assert.equal(
    writes.length,
    writesSoFar,
    'writeDoc is never invoked for a passing run either',
  );
});

test('a writeDoc failure is logged, not fatal to the run exit code, and does not un-send an already-sent notify', async () => {
  const notified: NotifyEvent[] = [];
  const { store: stateStore } = fakeStateStore({ writeShouldThrow: true });
  const failureRef = {
    current: { stage: 'farm', error: 'stalled: no beat() within 360000ms' },
  };
  const { store: runStore } = fakeRunStore(failureRef);
  const ctx = fakeCtx(notified, runStore, stateStore);

  const code = await run(ctx, failedResult('farm'), T0);
  assert.equal(
    code,
    1,
    'exit code reflects the run outcome, unaffected by the writeDoc failure',
  );
  assert.equal(
    notified.length,
    1,
    'ctx.notify already resolved before the writeDoc failure',
  );
});

test('direction 1 — same stage, same underlying cause, different volatile URL query string: one signature, second run suppressed', async () => {
  const notified: NotifyEvent[] = [];
  const { store: stateStore } = fakeStateStore();
  const failureRef = {
    current: {
      stage: 'farm',
      error: 'GET https://api.greenhouse.io/v1/boards/x?page=2&ts=169000 failed',
    },
  };
  const { store: runStore } = fakeRunStore(failureRef);
  const ctx = fakeCtx(notified, runStore, stateStore);

  await run(ctx, failedResult('farm'), T0);
  assert.equal(notified.length, 1);

  failureRef.current = {
    stage: 'farm',
    error: 'GET https://api.greenhouse.io/v1/boards/x?page=2&ts=555000 failed',
  };
  await run(ctx, failedResult('farm'), PLUS_1H);
  assert.equal(
    notified.length,
    1,
    'same origin+pathname, differing only in query — suppressed',
  );
});

test('direction 2 — same failedStage, genuinely different error text: both signatures notify, never suppressed', async () => {
  const notified: NotifyEvent[] = [];
  const { store: stateStore } = fakeStateStore();
  const failureRef = {
    current: { stage: 'farm', error: 'stalled: no beat() within 360000ms' },
  };
  const { store: runStore } = fakeRunStore(failureRef);
  const ctx = fakeCtx(notified, runStore, stateStore);

  await run(ctx, failedResult('farm'), T0);
  assert.equal(notified.length, 1);

  failureRef.current = { stage: 'farm', error: 'HTTP 429 from greenhouse' };
  await run(ctx, failedResult('farm'), PLUS_1H);
  assert.equal(
    notified.length,
    2,
    'a different underlying cause at the SAME stage must never be silently absorbed',
  );
});
