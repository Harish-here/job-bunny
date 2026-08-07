/**
 * routes.test.ts — TDD for `makeIntentRoutes`, mirroring
 * `features/board/routes.test.ts`'s pattern: fakes are plain object
 * literals (calls-recording closures), no `src/adapters/**` import
 * anywhere in this file. A fixed clock is injected so `request`/`cancel`/
 * `list` calls can be asserted against a known ISO string.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardSource, BoardStore } from '../../../ports/board.ts';
import type {
  CancelIntentResult,
  RunIntent,
  RunIntentStore,
} from '../../../ports/run_intents.ts';
import type { RunSummary } from '../../../ports/run_store.ts';
import type { BoardRequest } from '../../shared/index.ts';
import { HttpError } from '../../shared/index.ts';
import { makeIntentRoutes } from './routes.ts';

const FIXED_NOW = new Date('2026-08-07T09:00:00.000Z');
const fixedClock = () => FIXED_NOW;

function req(overrides: Partial<BoardRequest> = {}): BoardRequest {
  return { params: {}, query: new URLSearchParams(), body: undefined, ...overrides };
}

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

const SAMPLE_INTENT: RunIntent = {
  id: 1,
  requestedAt: '2026-08-07T09:00:00.000Z',
  status: 'pending',
  claimedRunId: null,
};

function fakeIntentStore(
  overrides: Partial<RunIntentStore> & { listResult?: RunIntent[] } = {},
): RunIntentStore & {
  requestCalls: string[];
  cancelCalls: Array<{ id: number; now: string }>;
  listCalls: Array<{ now: string; limit: number }>;
} {
  const { listResult = [SAMPLE_INTENT], ...rest } = overrides;
  const requestCalls: string[] = [];
  const cancelCalls: Array<{ id: number; now: string }> = [];
  const listCalls: Array<{ now: string; limit: number }> = [];
  return {
    requestCalls,
    cancelCalls,
    listCalls,
    request(now) {
      requestCalls.push(now);
      return { intent: SAMPLE_INTENT, deduped: false };
    },
    cancel(id, now) {
      cancelCalls.push({ id, now });
      return { outcome: 'cancelled', intent: { ...SAMPLE_INTENT, status: 'cancelled' } };
    },
    latest: () => SAMPLE_INTENT,
    list(now, limit) {
      listCalls.push({ now, limit });
      return listResult;
    },
    listClaimable: () => [],
    claim: () => true,
    attachRun: () => {},
    close() {},
    ...rest,
  };
}

function fakeRunsStore(rows: RunSummary[]): BoardStore {
  return {
    listJobs: () => ({ rows: [], total: 0 }),
    getJob: () => null,
    updateTracking: () => null,
    listRuns: () => ({ rows, total: rows.length }),
    getRun: () => null,
    listRunEvents: () => ({ rows: [], total: 0 }),
    close() {},
  };
}

function fakeSource(opts: {
  store?: BoardStore | null;
  intents?: RunIntentStore | null;
}): BoardSource & { openIntentsCalls: string[] } {
  const { store = null, intents = fakeIntentStore() } = opts;
  const openIntentsCalls: string[] = [];
  return {
    openIntentsCalls,
    listProfiles: async () => [],
    openStore: async () => store,
    readConfigDoc: async () => undefined,
    writeConfigDoc: async () => {},
    createProfile: async () => {},
    openIntents: async (name) => {
      openIntentsCalls.push(name);
      return intents;
    },
    listSecrets: async () => ({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' }),
    writeSecret: async () => {},
    runDoctor: async () => null,
    close() {},
  };
}

function findRoute(source: BoardSource, method: 'POST' | 'DELETE' | 'GET', path: string) {
  const route = makeIntentRoutes(source, fixedClock).find(
    (r) => r.method === method && r.path === path,
  );
  assert.ok(route, `no route for ${method} ${path}`);
  return route;
}

test('makeIntentRoutes: registers POST /api/profiles/:name/run-intents, DELETE /api/profiles/:name/run-intents/:id, and GET /api/profiles/:name/run-intents', () => {
  const routes = makeIntentRoutes(fakeSource({}), fixedClock);
  assert.deepEqual(
    routes.map((r) => ({ method: r.method, path: r.path })),
    [
      { method: 'POST', path: '/api/profiles/:name/run-intents' },
      { method: 'DELETE', path: '/api/profiles/:name/run-intents/:id' },
      { method: 'GET', path: '/api/profiles/:name/run-intents' },
    ],
  );
});

// --- POST /api/profiles/:name/run-intents ---

test('POST: a fresh intent is a 201 with deduped false', async () => {
  const intents = fakeIntentStore();
  const source = fakeSource({ intents });
  const route = findRoute(source, 'POST', '/api/profiles/:name/run-intents');
  const res = await route.handler(req({ params: { name: 'rajni' } }));
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { intent: SAMPLE_INTENT, deduped: false });
  assert.deepEqual(intents.requestCalls, [FIXED_NOW.toISOString()]);
});

test('POST: a deduped intent is a 200 with deduped true', async () => {
  const intents = fakeIntentStore({
    request: () => ({ intent: SAMPLE_INTENT, deduped: true }),
  });
  const source = fakeSource({ intents });
  const route = findRoute(source, 'POST', '/api/profiles/:name/run-intents');
  const res = await route.handler(req({ params: { name: 'rajni' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { intent: SAMPLE_INTENT, deduped: true });
});

test('POST: a running run is a 409 carrying the run id', async () => {
  const runningStore = fakeRunsStore([
    {
      id: 42,
      date: '2026-08-07',
      timeDir: '09-00',
      kind: 'run',
      resumedFrom: null,
      status: 'running',
      startedAt: '2026-08-07T09:00:00.000Z',
      finishedAt: null,
      heartbeatAt: '2026-08-07T09:00:00.000Z',
    },
  ]);
  const source = fakeSource({ store: runningStore });
  const route = findRoute(source, 'POST', '/api/profiles/:name/run-intents');
  const res = await route.handler(req({ params: { name: 'rajni' } }));
  assert.deepEqual(res, {
    status: 409,
    body: {
      error: {
        code: 'run_in_progress',
        message: 'a run is already in progress',
        runId: 42,
      },
    },
  });
  assert.deepEqual(source.openIntentsCalls, []);
});

test('POST: a crashed newest run does not block', async () => {
  const crashedStore = fakeRunsStore([
    {
      id: 41,
      date: '2026-08-07',
      timeDir: '08-00',
      kind: 'run',
      resumedFrom: null,
      status: 'crashed',
      startedAt: '2026-08-07T08:00:00.000Z',
      finishedAt: null,
      heartbeatAt: '2026-08-07T08:01:00.000Z',
    },
  ]);
  const source = fakeSource({ store: crashedStore });
  const route = findRoute(source, 'POST', '/api/profiles/:name/run-intents');
  const res = await route.handler(req({ params: { name: 'rajni' } }));
  assert.equal(res.status, 201);
});

test('POST: a profile with no database yet still queues an intent', async () => {
  const source = fakeSource({ store: null, intents: fakeIntentStore() });
  const route = findRoute(source, 'POST', '/api/profiles/:name/run-intents');
  const res = await route.handler(req({ params: { name: 'rajni' } }));
  assert.equal(res.status, 201);
});

test('POST: an unknown profile is a 404', async () => {
  const source = fakeSource({ store: null, intents: null });
  const route = findRoute(source, 'POST', '/api/profiles/:name/run-intents');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'nope' } })),
    404,
    'no_such_profile',
    'no such profile',
  );
});

// --- DELETE /api/profiles/:name/run-intents/:id ---

test('DELETE: cancelling a pending intent returns the cancelled row', async () => {
  const intents = fakeIntentStore();
  const source = fakeSource({ intents });
  const route = findRoute(source, 'DELETE', '/api/profiles/:name/run-intents/:id');
  const res = await route.handler(req({ params: { name: 'rajni', id: '1' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { intent: { ...SAMPLE_INTENT, status: 'cancelled' } });
  assert.deepEqual(intents.cancelCalls, [{ id: 1, now: FIXED_NOW.toISOString() }]);
});

test('DELETE: an unknown intent is a 404 and a claimed intent is a 409', async () => {
  const notFound = fakeIntentStore({
    cancel: (): CancelIntentResult => ({ outcome: 'not_found' }),
  });
  const notFoundSource = fakeSource({ intents: notFound });
  const notFoundRoute = findRoute(
    notFoundSource,
    'DELETE',
    '/api/profiles/:name/run-intents/:id',
  );
  await assertHttpError(
    () => notFoundRoute.handler(req({ params: { name: 'rajni', id: '99' } })),
    404,
    'not_found',
    'no such intent',
  );

  const notPending = fakeIntentStore({
    cancel: (): CancelIntentResult => ({ outcome: 'not_pending' }),
  });
  const notPendingSource = fakeSource({ intents: notPending });
  const notPendingRoute = findRoute(
    notPendingSource,
    'DELETE',
    '/api/profiles/:name/run-intents/:id',
  );
  await assertHttpError(
    () => notPendingRoute.handler(req({ params: { name: 'rajni', id: '1' } })),
    409,
    'intent_not_pending',
    'intent is no longer pending',
  );
});

test('DELETE: a non-numeric id is a 400', async () => {
  const source = fakeSource({});
  const route = findRoute(source, 'DELETE', '/api/profiles/:name/run-intents/:id');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'rajni', id: 'abc' } })),
    400,
    'bad_request',
    'invalid intent id',
  );
});

// --- GET /api/profiles/:name/run-intents ---

test('GET: lists intents newest-first capped at the default limit', async () => {
  const rows: RunIntent[] = [
    {
      id: 9,
      requestedAt: '2026-08-07T08:59:00.000Z',
      status: 'pending',
      claimedRunId: null,
    },
    {
      id: 7,
      requestedAt: '2026-08-07T08:00:00.000Z',
      status: 'cancelled',
      claimedRunId: null,
    },
  ];
  const intents = fakeIntentStore({ listResult: rows });
  const source = fakeSource({ intents });
  const route = findRoute(source, 'GET', '/api/profiles/:name/run-intents');
  const res = await route.handler(req({ params: { name: 'rajni' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { rows });
  assert.deepEqual(intents.listCalls, [{ now: FIXED_NOW.toISOString(), limit: 20 }]);
});

test('GET: a stale pending intent serializes as expired', async () => {
  const rows: RunIntent[] = [
    {
      id: 3,
      requestedAt: '2026-08-07T08:00:00.000Z',
      status: 'expired',
      claimedRunId: null,
    },
  ];
  const intents = fakeIntentStore({ listResult: rows });
  const source = fakeSource({ intents });
  const route = findRoute(source, 'GET', '/api/profiles/:name/run-intents');
  const res = await route.handler(req({ params: { name: 'rajni' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { rows });
});

test('GET: an unknown profile is a 404', async () => {
  const source = fakeSource({ intents: null });
  const route = findRoute(source, 'GET', '/api/profiles/:name/run-intents');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'nope' } })),
    404,
    'no_such_profile',
    'no such profile',
  );
});
