/**
 * runs.test.ts (Task 12) — `runsCommand` exercised entirely against fake
 * `BoardSource`/`BoardStore` object literals (mirroring `board.test.ts`'s
 * fake-source pattern and `app/features/runs/routes.test.ts`'s
 * `SAMPLE_SUMMARY`/`SAMPLE_DETAIL` fixtures): no real `wireBoard`, no real
 * sqlite file anywhere in this file.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardSource, BoardStore } from '../../ports/board.ts';
import type { RunDetail, RunEventRow, RunSummary } from '../../ports/run_store.ts';
import { type RunsDeps, runsCommand } from './runs.ts';

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

function fakeStore(overrides: Partial<BoardStore> = {}): BoardStore {
  return {
    listJobs: () => ({ rows: [], total: 0 }),
    getJob: () => null,
    updateTracking: () => null,
    listRuns: () => ({ rows: [], total: 0 }),
    getRun: () => null,
    listRunEvents: () => ({ rows: [], total: 0 }),
    close: () => {},
    ...overrides,
  };
}

function fakeSource(store: BoardStore | null): BoardSource & { closed: boolean } {
  const state = { closed: false };
  return {
    get closed() {
      return state.closed;
    },
    listProfiles: async () => [],
    openStore: async () => store,
    readConfigDoc: async () => undefined,
    writeConfigDoc: async () => {},
    createProfile: async () => {},
    openIntents: async () => null,
    listSecrets: async () => ({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' }),
    writeSecret: async () => {},
    runDoctor: async () => null,
    close: () => {
      state.closed = true;
    },
  };
}

const PASSED_SUMMARY: RunSummary = {
  id: 1,
  date: '2026-08-05',
  timeDir: '09-00',
  kind: 'run',
  resumedFrom: null,
  status: 'passed',
  startedAt: '2026-08-05T09:00:00.000Z',
  finishedAt: '2026-08-05T09:00:42.000Z',
  heartbeatAt: '2026-08-05T09:00:40.000Z',
};

const FAILED_SUMMARY: RunSummary = {
  id: 2,
  date: '2026-08-05',
  timeDir: '10-00',
  kind: 'run',
  resumedFrom: null,
  status: 'failed',
  startedAt: '2026-08-05T10:00:00.000Z',
  finishedAt: '2026-08-05T10:01:30.000Z',
  heartbeatAt: '2026-08-05T10:01:00.000Z',
};

const RUNNING_SUMMARY: RunSummary = {
  id: 3,
  date: '2026-08-05',
  timeDir: null,
  kind: 'stage',
  resumedFrom: null,
  status: 'running',
  startedAt: '2026-08-05T11:00:00.000Z',
  finishedAt: null,
  heartbeatAt: '2026-08-05T11:00:05.000Z',
};

const FAILED_RESULT = {
  profile: 'rajni',
  date: '2026-08-05',
  time: '10-00',
  outcome: 'failed',
  failedStage: 'structure',
  stages: [
    { name: 'farm', elapsedMs: 10, attempts: 1, jobsIn: 0, jobsOut: 5, dropsByRule: {} },
  ],
};

const FAILED_DETAIL: RunDetail = {
  ...FAILED_SUMMARY,
  result: FAILED_RESULT,
  failure: {
    stage: 'structure',
    error: 'timed out',
    elapsedMs: 5000,
    lastCheckpoint: '02-farm.json',
  },
  syncDryrun: null,
};

test('runsCommand: unknown/no-db profile prints a friendly message and returns 1', async () => {
  const out = collector();
  const deps: Partial<RunsDeps> = { wireBoard: () => fakeSource(null), write: out.write };
  const code = await runsCommand({ profile: 'ghost' }, deps);
  assert.equal(code, 1);
  assert.ok(
    out.lines.some((l) => l.includes('ghost')),
    out.lines.join('\n'),
  );
});

test('runsCommand: list prints one line per run, duration "running" when unfinished', async () => {
  const out = collector();
  const store = fakeStore({
    listRuns: () => ({ rows: [PASSED_SUMMARY, RUNNING_SUMMARY], total: 2 }),
  });
  const deps: Partial<RunsDeps> = {
    wireBoard: () => fakeSource(store),
    write: out.write,
  };
  const code = await runsCommand({ profile: 'rajni' }, deps);
  assert.equal(code, 0);
  assert.equal(out.lines.length, 2);
  assert.equal(out.lines[0], '#1  2026-08-05 09-00  run  passed  42s  ');
  assert.equal(out.lines[1], '#3  2026-08-05 -  stage  running  running  ');
});

test('runsCommand: list recovers failedStage for a failed row via getRun', async () => {
  const out = collector();
  const getRunCalls: number[] = [];
  const store = fakeStore({
    listRuns: () => ({ rows: [FAILED_SUMMARY], total: 1 }),
    getRun: (id: number) => {
      getRunCalls.push(id);
      return FAILED_DETAIL;
    },
  });
  const deps: Partial<RunsDeps> = {
    wireBoard: () => fakeSource(store),
    write: out.write,
  };
  const code = await runsCommand({ profile: 'rajni' }, deps);
  assert.equal(code, 0);
  assert.deepEqual(getRunCalls, [2]);
  assert.equal(out.lines[0], '#2  2026-08-05 10-00  run  failed  1m 30s  structure');
});

test('runsCommand: list does NOT call getRun for non-failed rows', async () => {
  const out = collector();
  let getRunCalls = 0;
  const store = fakeStore({
    listRuns: () => ({ rows: [PASSED_SUMMARY], total: 1 }),
    getRun: () => {
      getRunCalls++;
      return null;
    },
  });
  const deps: Partial<RunsDeps> = {
    wireBoard: () => fakeSource(store),
    write: out.write,
  };
  await runsCommand({ profile: 'rajni' }, deps);
  assert.equal(getRunCalls, 0);
});

test('runsCommand: show — unknown run id prints a friendly message and returns 1', async () => {
  const out = collector();
  const store = fakeStore({ getRun: () => null });
  const deps: Partial<RunsDeps> = {
    wireBoard: () => fakeSource(store),
    write: out.write,
  };
  const code = await runsCommand({ profile: 'rajni', runId: 999 }, deps);
  assert.equal(code, 1);
  assert.ok(
    out.lines.some((l) => l.includes('999')),
    out.lines.join('\n'),
  );
});

test('runsCommand: show prints summary, failure block, funnel lines, and events', async () => {
  const out = collector();
  const events: RunEventRow[] = [
    { ts: '2026-08-05T10:00:01.000Z', level: 'info', msg: 'stage started' },
    {
      ts: '2026-08-05T10:00:02.000Z',
      level: 'error',
      msg: 'stage failed',
      data: { stage: 'structure' },
    },
  ];
  const store = fakeStore({
    getRun: (id) => (id === 2 ? FAILED_DETAIL : null),
    listRunEvents: (id) =>
      id === 2 ? { rows: events, total: 2 } : { rows: [], total: 0 },
  });
  const deps: Partial<RunsDeps> = {
    wireBoard: () => fakeSource(store),
    write: out.write,
  };
  const code = await runsCommand({ profile: 'rajni', runId: 2 }, deps);
  assert.equal(code, 0);
  assert.deepEqual(out.lines, [
    '#2  2026-08-05 10-00  run  failed  1m 30s  structure',
    'failure:',
    '  stage: structure',
    '  error: timed out',
    '  elapsedMs: 5000',
    '  lastCheckpoint: 02-farm.json',
    '  farm: 0 -> 5',
    '2026-08-05T10:00:01.000Z info stage started',
    '2026-08-05T10:00:02.000Z error stage failed {"stage":"structure"}',
  ]);
});

test('runsCommand: show omits the failure block when failure is null', async () => {
  const out = collector();
  const passedDetail: RunDetail = {
    ...PASSED_SUMMARY,
    result: {
      profile: 'rajni',
      date: '2026-08-05',
      time: '09-00',
      outcome: 'passed',
      stages: [],
    },
    failure: null,
    syncDryrun: null,
  };
  const store = fakeStore({
    getRun: () => passedDetail,
    listRunEvents: () => ({ rows: [], total: 0 }),
  });
  const deps: Partial<RunsDeps> = {
    wireBoard: () => fakeSource(store),
    write: out.write,
  };
  const code = await runsCommand({ profile: 'rajni', runId: 1 }, deps);
  assert.equal(code, 0);
  assert.deepEqual(out.lines, ['#1  2026-08-05 09-00  run  passed  42s  ']);
});

test('runsCommand: closes the source after use, even on the unknown-profile path', async () => {
  const source = fakeSource(null);
  const deps: Partial<RunsDeps> = { wireBoard: () => source, write: () => {} };
  await runsCommand({ profile: 'ghost' }, deps);
  assert.ok(source.closed);
});
