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
function fakeRunStore(failureRef: { current: unknown }): {
  store: RunStore;
  events: Array<{ level: string; msg: string }>;
} {
  let nextId = 1;
  const events: Array<{ level: string; msg: string }> = [];
  const store: RunStore = {
    startRun() {
      return nextId++;
    },
    appendEvents(_runId, rows) {
      for (const row of rows) events.push({ level: row.level, msg: row.msg });
    },
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
  return { store, events };
}

/** Persists ONE doc across however many `readDoc`/`writeDoc` calls this
 * fake sees — real cross-run dedup state, not reset between `runCommand`
 * invocations that share this same fake instance. */
function fakeStateStore(
  opts: { writeShouldThrow?: boolean; readShouldThrow?: boolean } = {},
): {
  store: StateStore;
  reads: string[];
  writes: Array<{ key: string; value: unknown }>;
} {
  let doc: unknown;
  const reads: string[] = [];
  const writes: Array<{ key: string; value: unknown }> = [];
  const store: StateStore = {
    async readDoc(key, schema) {
      reads.push(key);
      // Mirrors the real sqlite adapter's own contract
      // (`ports/state_store.ts`: "throws on schema mismatch") — a doc that
      // EXISTS but fails to parse against the caller's schema throws,
      // rather than returning `undefined`.
      if (opts.readShouldThrow && doc !== undefined) {
        schema.parse({ notAValidDedupState: true });
      }
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

/** Mirrors `composeFailureNotice`'s own private `formatSince` (local-time
 * `YYYY-MM-DD HH:MM`) so the T3 assertion below stays correct under
 * whatever timezone the test happens to run in, rather than hardcoding a
 * single machine's local rendering of `T0`. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

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

test('a readDoc failure (existing doc fails schema validation) is logged, not fatal — the run still notifies, per "fails toward MORE notification"', async () => {
  const notified: NotifyEvent[] = [];
  const { store: stateStore } = fakeStateStore();
  const failureRef = {
    current: { stage: 'farm', error: 'stalled: no beat() within 360000ms' },
  };
  // `runStore` (and its `events` buffer) is shared across BOTH runs below —
  // `run.ts` replaces `ctx.logger` with a `RunStoreLogger` wrapping this
  // exact store (`createRunLogger`), so this is the only place a `warn()`
  // call made deep inside `sendFailureDigest` is observable from the test.
  const { store: runStore, events } = fakeRunStore(failureRef);
  const ctx = fakeCtx(notified, runStore, stateStore);

  // First run writes a doc, so the SECOND run's readDoc has something to
  // (fail to) parse.
  await run(ctx, failedResult('farm'), T0);
  assert.equal(notified.length, 1);

  const { store: throwingStateStore } = fakeStateStore({ readShouldThrow: true });
  // Seed the throwing store with a prior doc via one silent write, then
  // exercise it — mirrors a real profile's dedup doc existing but no
  // longer matching `DedupStateSchema` (e.g. after a future shape change),
  // reproducing the real sqlite adapter's own documented "throws on schema
  // mismatch" contract (`ports/state_store.ts`), not a synthetic one.
  await throwingStateStore.writeDoc('notify/failure_dedup.json', {
    signature: 'farm::stalled',
    firstSeenAt: T0.toISOString(),
    lastNotifiedAt: T0.toISOString(),
    consecutiveCount: 1,
  });
  const ctx2 = fakeCtx(notified, runStore, throwingStateStore);

  const code = await run(ctx2, failedResult('farm'), PLUS_1H);
  assert.equal(code, 1, 'exit code reflects the run outcome');
  assert.equal(
    notified.length,
    2,
    'a readDoc throw must not swallow the failure notification — this run still notifies',
  );
  const warnings = events.filter((e) => e.level === 'warn');
  assert.equal(warnings.length, 1, 'the readDoc failure is logged, not silently dropped');
  assert.match(warnings[0]?.msg ?? '', /failed to read failure-dedup state/);
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
  // The "STILL OPEN" line describes the SUPPRESSED (old) signature's own
  // accumulated state — one send at T0 plus one suppress at PLUS_1H makes
  // consecutiveCount 2, firstSeenAt still T0 — NOT the new signature's own
  // freshly-reset `nextState` (consecutiveCount 1, firstSeenAt PLUS_1H),
  // which would tell the operator the old failure just started when it had
  // actually recurred twice since T0.
  assert.match(text, new RegExp(`\\(x2, since ${localStamp(T0)}\\)`));
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

test('accepted risk: ctx.notify carries no delivery signal (Promise<void>) — a silently-dropped send still stamps dedup state and suppresses the SAME recurring failure for up to 24h', async () => {
  const notified: NotifyEvent[] = [];
  const { store: stateStore, writes } = fakeStateStore();
  const failureRef = {
    current: { stage: 'farm', error: 'stalled: no beat() within 360000ms' },
  };
  const { store: runStore } = fakeRunStore(failureRef);
  // `fakeCtx`'s `notify` just records the call and resolves — the real
  // `Promise<void>` contract (`pipeline/runner/context.ts`), whose actual
  // implementation (`cli/wire/compose.ts`) is `Promise.allSettled` plus
  // per-notifier error logging. This is indistinguishable, from
  // `sendFailureDigest`'s own vantage point, from a SILENTLY DROPPED send
  // (revoked Telegram token, a timed-out fetch, disk full) — see
  // `run_failure_notice.ts`'s own "Accepted risk" doc comment.
  const ctx = fakeCtx(notified, runStore, stateStore);

  const code1 = await run(ctx, failedResult('farm'), T0);
  assert.equal(code1, 1);
  assert.equal(notified.length, 1, 'first failure "sends" (call made, delivery unknown)');
  assert.equal(writes.length, 1, 'dedup state is stamped regardless of delivery outcome');

  // The SAME underlying cause recurs within 24h — per the accepted-risk
  // contract this is suppressed exactly as if the first send had genuinely
  // been delivered, even though nothing here proves it was (an outage
  // during the first failure would silently cost every recurrence up to
  // 24h later).
  const code2 = await run(ctx, failedResult('farm'), PLUS_1H);
  assert.equal(code2, 1);
  assert.equal(
    notified.length,
    1,
    'suppressed for 24h — this is the documented accepted risk, not a bug',
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
