/**
 * routes.test.ts — TDD for `makeRunsRoutes`, mirroring
 * `features/board/routes.test.ts`'s pattern exactly: fakes are plain
 * object literals (calls-recording closures), no `src/adapters/**`
 * import anywhere in this file.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  BoardSource,
  BoardStore,
  DaemonStatus,
  RunDurationEstimate,
} from '../../../ports/board.ts';
import type { DeferredSlotRow } from '../../../ports/deferred_slots.ts';
import type { RunDetail, RunEventRow, RunSummary } from '../../../ports/run_store.ts';
import type { BoardRequest } from '../../shared/index.ts';
import { HttpError } from '../../shared/index.ts';
import { makeRunsRoutes } from './routes.ts';

const FAKE_DAEMON_STATUS: DaemonStatus = {
  state: 'stopped',
  pid: null,
  startedAt: null,
  lastTickAt: null,
  inFlight: null,
  profiles: [],
};

function req(overrides: Partial<BoardRequest> = {}): BoardRequest {
  return { params: {}, query: new URLSearchParams(), body: undefined, ...overrides };
}

/** Every handler is `async` now that `openStoreOrThrow` awaits the
 * `BoardSource` port — a synchronous `assert.throws` can never observe the
 * throw, it surfaces only as a rejection. */
async function assertHttpError(
  fn: () => unknown,
  status: number,
  code: string,
  message?: string,
) {
  await assert.rejects(
    async () => fn(),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, status);
      assert.equal(err.code, code);
      if (message !== undefined) assert.equal(err.message, message);
      return true;
    },
  );
}

const SAMPLE_SUMMARY: RunSummary = {
  id: 7,
  date: '2026-08-05',
  timeDir: '09-00',
  kind: 'run',
  resumedFrom: null,
  status: 'passed',
  startedAt: '2026-08-05T09:00:00.000Z',
  finishedAt: '2026-08-05T09:05:00.000Z',
  heartbeatAt: '2026-08-05T09:04:00.000Z',
  progress: null,
  catchupSlots: null,
};

const SAMPLE_DETAIL: RunDetail = {
  ...SAMPLE_SUMMARY,
  result: { funnel: { in: 5, out: 3 } },
  failure: null,
  syncDryrun: null,
};

const SAMPLE_EVENT: RunEventRow = {
  ts: '2026-08-05T09:01:00.000Z',
  level: 'info',
  msg: 'stage passed',
};

const SOFT_ERROR_EVENTS: RunEventRow[] = [
  { ts: '2026-08-05T09:01:00.000Z', level: 'info', msg: 'stage passed' },
  {
    ts: '2026-08-05T09:01:01.000Z',
    level: 'warn',
    msg: 'linkedin lane: url failed',
    data: { scope: 'source.linkedin', lane: 'linkedin' },
  },
  {
    ts: '2026-08-05T09:01:02.000Z',
    level: 'warn',
    msg: 'linkedin lane: url failed',
    data: { scope: 'source.linkedin', lane: 'linkedin' },
  },
  {
    ts: '2026-08-05T09:01:03.000Z',
    level: 'error',
    msg: 'board fetch failed',
    data: { scope: 'source', company: 'acme corp' },
  },
];

function fakeStore(overrides: Partial<BoardStore> = {}): BoardStore & {
  listRunsCalls: Array<{ limit?: number; offset?: number }>;
  listRunEventsCalls: Array<{ id: number; query: { limit?: number; offset?: number } }>;
  listRunHealthCalls: number[][];
  estimateRunDurationCalls: number[];
} {
  const listRunsCalls: Array<{ limit?: number; offset?: number }> = [];
  const listRunEventsCalls: Array<{
    id: number;
    query: { limit?: number; offset?: number };
  }> = [];
  const listRunHealthCalls: number[][] = [];
  const estimateRunDurationCalls: number[] = [];
  return {
    listRunsCalls,
    listRunEventsCalls,
    listRunHealthCalls,
    estimateRunDurationCalls,
    listJobs: () => ({ rows: [], total: 0 }),
    getJob: () => null,
    updateTracking: () => null,
    listRuns(query) {
      listRunsCalls.push(query);
      return { rows: [SAMPLE_SUMMARY], total: 1 };
    },
    getRun(id) {
      return id === SAMPLE_SUMMARY.id ? SAMPLE_DETAIL : null;
    },
    listRunEvents(id, query) {
      listRunEventsCalls.push({ id, query });
      return { rows: [SAMPLE_EVENT], total: 1 };
    },
    listRunHealth(runIds) {
      listRunHealthCalls.push(runIds);
      return new Map();
    },
    listDeferredSlots: () => ({ rows: [], total: 0 }),
    estimateRunDuration(): RunDurationEstimate | null {
      estimateRunDurationCalls.push(1);
      return { medianMs: 30 * 60_000, sampleSize: 10 };
    },
    close() {},
    ...overrides,
  };
}

function fakeSource(store: BoardStore | null): BoardSource {
  return {
    listProfiles: async () => [],
    openStore: async () => store,
    readConfigDoc: async () => undefined,
    writeConfigDoc: async () => {},
    createProfile: async () => {},
    openIntents: async () => null,
    listSecrets: async () => ({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' }),
    writeSecret: async () => {},
    removeProfile: async () => ({ outcome: 'removed' }),
    runDoctor: async () => null,
    previewFilterRule: async () => ({ available: false, reason: 'no_recent_run' }),
    stopDaemon: async () => ({ outcome: 'stopped' }),
    startDaemon: async () => ({ outcome: 'started' }),
    readDaemonStatus: async () => FAKE_DAEMON_STATUS,
    close() {},
  };
}

function findRoute(source: BoardSource, path: string) {
  const route = makeRunsRoutes(source).find((r) => r.method === 'GET' && r.path === path);
  assert.ok(route, `no route for GET ${path}`);
  return route;
}

// --- GET /api/profiles/:name/runs ---

test('list: happy path with defaults', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs');
  const res = await route.handler(req({ params: { name: 'rajni' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    rows: [
      {
        ...SAMPLE_SUMMARY,
        softErrors: {
          total: 0,
          groups: [],
          breakerOpen: false,
          capsHit: { maxNewPerLane: false, maxCardsPerUrl: false },
        },
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  });
  assert.deepEqual(store.listRunsCalls[0], { limit: undefined, offset: undefined });
  // ONE batched health query for the whole page, not a per-row fetch.
  assert.deepEqual(store.listRunHealthCalls, [[SAMPLE_SUMMARY.id]]);
});

test('list: merges the batched listRunHealth map onto each row as softErrors (health-gate inputs, no per-row fetch — fix-round finding #4)', async () => {
  const store = fakeStore({
    listRunHealth(runIds) {
      store.listRunHealthCalls.push(runIds);
      const map = new Map<number, { total: number; breakerOpen: boolean }>();
      map.set(SAMPLE_SUMMARY.id, { total: 5, breakerOpen: true });
      return map;
    },
  });
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs');
  const res = await route.handler(req({ params: { name: 'rajni' } }));
  assert.equal(res.status, 200);
  const body = res.body as { rows: Array<{ softErrors: unknown }> };
  assert.deepEqual(body.rows[0]?.softErrors, {
    total: 5,
    groups: [],
    breakerOpen: true,
    capsHit: { maxNewPerLane: false, maxCardsPerUrl: false },
  });
  assert.deepEqual(store.listRunHealthCalls, [[SAMPLE_SUMMARY.id]]);
});

test('list: ?limit=10&offset=5 reaches the store and echoes into the response envelope', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs');
  const res = await route.handler(
    req({
      params: { name: 'rajni' },
      query: new URLSearchParams({ limit: '10', offset: '5' }),
    }),
  );
  assert.equal(res.status, 200);
  const body = res.body as { limit: number; offset: number };
  assert.equal(body.limit, 10);
  assert.equal(body.offset, 5);
  assert.deepEqual(store.listRunsCalls[0], { limit: 10, offset: 5 });
});

test('list: ?limit=201 is a 400 validation error (cap is 200)', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs');
  await assertHttpError(
    () =>
      route.handler(
        req({ params: { name: 'rajni' }, query: new URLSearchParams({ limit: '201' }) }),
      ),
    400,
    'validation',
  );
  assert.equal(store.listRunsCalls.length, 0);
});

test('list: null store (no local db) is a 404 no_local_db', async () => {
  const route = findRoute(fakeSource(null), '/api/profiles/:name/runs');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'notion-only' } })),
    404,
    'no_local_db',
    'profile has no local database (pure-Notion profiles are read via Notion)',
  );
});

// --- GET /api/profiles/:name/runs/:id ---

test('get: 200 for a known id; estimatedDurationMs is null for a status: passed run even when the store has enough history to answer, and estimateRunDuration is never even called', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs/:id');
  const res = await route.handler(req({ params: { name: 'rajni', id: '7' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ...SAMPLE_DETAIL, estimatedDurationMs: null });
  assert.deepEqual(store.estimateRunDurationCalls, []);
});

test('get: estimatedDurationMs is populated (blueprint step 1.18) for a status: running run', async () => {
  const runningDetail = {
    ...SAMPLE_DETAIL,
    status: 'running' as const,
    finishedAt: null,
  };
  const store = fakeStore({
    getRun: (id) => (id === SAMPLE_SUMMARY.id ? runningDetail : null),
  });
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs/:id');
  const res = await route.handler(req({ params: { name: 'rajni', id: '7' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ...runningDetail, estimatedDurationMs: 30 * 60_000 });
  assert.deepEqual(store.estimateRunDurationCalls, [1]);
});

test('get: estimatedDurationMs is null for a status: running run when the store has too little history to estimate', async () => {
  const runningDetail = {
    ...SAMPLE_DETAIL,
    status: 'running' as const,
    finishedAt: null,
  };
  const store = fakeStore({
    getRun: (id) => (id === SAMPLE_SUMMARY.id ? runningDetail : null),
    estimateRunDuration: () => null,
  });
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs/:id');
  const res = await route.handler(req({ params: { name: 'rajni', id: '7' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ...runningDetail, estimatedDurationMs: null });
});

test('get: 404 for an unknown id', async () => {
  const route = findRoute(fakeSource(fakeStore()), '/api/profiles/:name/runs/:id');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'rajni', id: '999' } })),
    404,
    'not_found',
  );
});

test('get: non-numeric id is a 400 validation error', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs/:id');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'rajni', id: 'abc' } })),
    400,
    'validation',
  );
});

test('get: null store (no local db) is a 404 no_local_db', async () => {
  const route = findRoute(fakeSource(null), '/api/profiles/:name/runs/:id');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'notion-only', id: '7' } })),
    404,
    'no_local_db',
  );
});

// --- GET /api/profiles/:name/runs/:id/events ---

test('events: happy path with defaults', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs/:id/events');
  const res = await route.handler(req({ params: { name: 'rajni', id: '7' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { rows: [SAMPLE_EVENT], total: 1, limit: 500, offset: 0 });
  assert.deepEqual(store.listRunEventsCalls[0], {
    id: 7,
    query: { limit: undefined, offset: undefined },
  });
});

test('events: ?limit=1001 is a 400 validation error (cap is 1000)', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs/:id/events');
  await assertHttpError(
    () =>
      route.handler(
        req({
          params: { name: 'rajni', id: '7' },
          query: new URLSearchParams({ limit: '1001' }),
        }),
      ),
    400,
    'validation',
  );
  assert.equal(store.listRunEventsCalls.length, 0);
});

test('events: 404 for an unknown run id (checked via getRun before listRunEvents)', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs/:id/events');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'rajni', id: '999' } })),
    404,
    'not_found',
  );
  assert.equal(store.listRunEventsCalls.length, 0);
});

test('events: non-numeric id is a 400 validation error', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs/:id/events');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'rajni', id: 'abc' } })),
    400,
    'validation',
  );
});

test('events: null store (no local db) is a 404 no_local_db', async () => {
  const route = findRoute(fakeSource(null), '/api/profiles/:name/runs/:id/events');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'notion-only', id: '7' } })),
    404,
    'no_local_db',
  );
});

// --- GET /api/profiles/:name/runs/:id/soft-errors ---

test('soft-errors: happy path groups warn/error rows and excludes info', async () => {
  const store = fakeStore({
    listRunEvents(id, query) {
      store.listRunEventsCalls.push({ id, query });
      return { rows: SOFT_ERROR_EVENTS, total: SOFT_ERROR_EVENTS.length };
    },
  });
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs/:id/soft-errors');
  const res = await route.handler(req({ params: { name: 'rajni', id: '7' } }));
  assert.equal(res.status, 200);
  const body = res.body as {
    total: number;
    groups: Array<{ key: string; count: number }>;
  };
  // 3 warn/error rows total, the info row excluded
  assert.equal(body.total, 3);
  assert.equal(body.groups.length, 2);
  assert.deepEqual(
    body.groups.map((g) => g.key).sort(),
    ['source.linkedin·linkedin', 'source·acme corp'].sort(),
  );
  assert.deepEqual(store.listRunEventsCalls[0], {
    id: 7,
    query: { limit: 2000 },
  });
});

test('soft-errors: 404 for an unknown run id (checked via getRun before listRunEvents)', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs/:id/soft-errors');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'rajni', id: '999' } })),
    404,
    'not_found',
  );
  assert.equal(store.listRunEventsCalls.length, 0);
});

test('soft-errors: null store (no local db) is a 404 no_local_db', async () => {
  const route = findRoute(fakeSource(null), '/api/profiles/:name/runs/:id/soft-errors');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'notion-only', id: '7' } })),
    404,
    'no_local_db',
  );
});

test('soft-errors: non-numeric id is a 400 validation error', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs/:id/soft-errors');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'rajni', id: 'abc' } })),
    400,
    'validation',
  );
});

// --- GET /api/profiles/:name/deferred-slots ---

function fakeDeferredSlot(overrides: Partial<DeferredSlotRow> = {}): DeferredSlotRow {
  return {
    runDate: '2026-08-13',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'host was asleep',
    decidedAt: '2026-08-13T09:00:05.000Z',
    notifiedAt: null,
    ...overrides,
  };
}

const TODAY_SLOTS: DeferredSlotRow[] = [
  fakeDeferredSlot({ slot: '05:00' }),
  fakeDeferredSlot({ slot: '09:00' }),
  fakeDeferredSlot({ slot: '13:00' }),
  fakeDeferredSlot({ slot: '17:00' }),
  fakeDeferredSlot({ slot: '21:00' }),
];

const OTHER_DATE_SLOTS: DeferredSlotRow[] = [
  fakeDeferredSlot({ runDate: '2026-07-01', slot: '10:00' }),
];

test('deferred-slots: a profile with 5 deferred rows for today returns exactly those 5', async () => {
  const listDeferredSlotsCalls: Array<{ date?: string }> = [];
  const store = fakeStore({
    listDeferredSlots(query) {
      listDeferredSlotsCalls.push(query);
      return { rows: TODAY_SLOTS, total: TODAY_SLOTS.length };
    },
  });
  const route = findRoute(fakeSource(store), '/api/profiles/:name/deferred-slots');
  const res = await route.handler(req({ params: { name: 'rajni' } }));
  assert.equal(res.status, 200);
  const body = res.body as { rows: DeferredSlotRow[]; total: number; date: string };
  assert.equal(body.rows.length, 5);
  assert.deepEqual(body.rows, TODAY_SLOTS);
  assert.equal(body.total, 5);
  // date defaults to today (local) — a fixed regex shape check, not a
  // literal date, so this test never rots at midnight.
  assert.match(body.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(listDeferredSlotsCalls[0]?.date, body.date);
});

test("deferred-slots: ?date=YYYY-MM-DD scopes to a different date's rows", async () => {
  const listDeferredSlotsCalls: Array<{ date?: string }> = [];
  const store = fakeStore({
    listDeferredSlots(query) {
      listDeferredSlotsCalls.push(query);
      return { rows: OTHER_DATE_SLOTS, total: OTHER_DATE_SLOTS.length };
    },
  });
  const route = findRoute(fakeSource(store), '/api/profiles/:name/deferred-slots');
  const res = await route.handler(
    req({
      params: { name: 'rajni' },
      query: new URLSearchParams({ date: '2026-07-01' }),
    }),
  );
  assert.equal(res.status, 200);
  const body = res.body as { rows: DeferredSlotRow[]; total: number; date: string };
  assert.deepEqual(body.rows, OTHER_DATE_SLOTS);
  assert.equal(body.total, 1);
  assert.equal(body.date, '2026-07-01');
  assert.deepEqual(listDeferredSlotsCalls, [{ date: '2026-07-01' }]);
});

test('deferred-slots: malformed ?date= is a 400 validation error', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/deferred-slots');
  await assertHttpError(
    () =>
      route.handler(
        req({
          params: { name: 'rajni' },
          query: new URLSearchParams({ date: 'not-a-date' }),
        }),
      ),
    400,
    'validation',
  );
});

test('deferred-slots: null store (no local db) is a 404 no_local_db, same shape as every other runs route', async () => {
  const route = findRoute(fakeSource(null), '/api/profiles/:name/deferred-slots');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'notion-only' } })),
    404,
    'no_local_db',
    'profile has no local database (pure-Notion profiles are read via Notion)',
  );
});
