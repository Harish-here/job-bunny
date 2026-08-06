/**
 * routes.test.ts — TDD for `makeRunsRoutes`, mirroring
 * `features/board/routes.test.ts`'s pattern exactly: fakes are plain
 * object literals (calls-recording closures), no `src/adapters/**`
 * import anywhere in this file.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardSource, BoardStore } from '../../../ports/board.ts';
import type { RunDetail, RunEventRow, RunSummary } from '../../../ports/run_store.ts';
import type { BoardRequest } from '../../shared/index.ts';
import { HttpError } from '../../shared/index.ts';
import { makeRunsRoutes } from './routes.ts';

function req(overrides: Partial<BoardRequest> = {}): BoardRequest {
  return { params: {}, query: new URLSearchParams(), body: undefined, ...overrides };
}

function assertHttpError(
  fn: () => unknown,
  status: number,
  code: string,
  message?: string,
) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    if (message !== undefined) assert.equal(err.message, message);
    return true;
  });
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

function fakeStore(overrides: Partial<BoardStore> = {}): BoardStore & {
  listRunsCalls: Array<{ limit?: number; offset?: number }>;
  listRunEventsCalls: Array<{ id: number; query: { limit?: number; offset?: number } }>;
} {
  const listRunsCalls: Array<{ limit?: number; offset?: number }> = [];
  const listRunEventsCalls: Array<{
    id: number;
    query: { limit?: number; offset?: number };
  }> = [];
  return {
    listRunsCalls,
    listRunEventsCalls,
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
    close() {},
    ...overrides,
  };
}

function fakeSource(store: BoardStore | null): BoardSource {
  return {
    listProfiles: () => [],
    openStore: () => store,
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
    rows: [SAMPLE_SUMMARY],
    total: 1,
    limit: 50,
    offset: 0,
  });
  assert.deepEqual(store.listRunsCalls[0], { limit: undefined, offset: undefined });
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

test('list: ?limit=201 is a 400 validation error (cap is 200)', () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs');
  assertHttpError(
    () =>
      route.handler(
        req({ params: { name: 'rajni' }, query: new URLSearchParams({ limit: '201' }) }),
      ),
    400,
    'validation',
  );
  assert.equal(store.listRunsCalls.length, 0);
});

test('list: null store (no local db) is a 404 no_local_db', () => {
  const route = findRoute(fakeSource(null), '/api/profiles/:name/runs');
  assertHttpError(
    () => route.handler(req({ params: { name: 'notion-only' } })),
    404,
    'no_local_db',
    'profile has no local database (pure-Notion profiles are read via Notion)',
  );
});

// --- GET /api/profiles/:name/runs/:id ---

test('get: 200 for a known id', async () => {
  const route = findRoute(fakeSource(fakeStore()), '/api/profiles/:name/runs/:id');
  const res = await route.handler(req({ params: { name: 'rajni', id: '7' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, SAMPLE_DETAIL);
});

test('get: 404 for an unknown id', () => {
  const route = findRoute(fakeSource(fakeStore()), '/api/profiles/:name/runs/:id');
  assertHttpError(
    () => route.handler(req({ params: { name: 'rajni', id: '999' } })),
    404,
    'not_found',
  );
});

test('get: non-numeric id is a 400 validation error', () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs/:id');
  assertHttpError(
    () => route.handler(req({ params: { name: 'rajni', id: 'abc' } })),
    400,
    'validation',
  );
});

test('get: null store (no local db) is a 404 no_local_db', () => {
  const route = findRoute(fakeSource(null), '/api/profiles/:name/runs/:id');
  assertHttpError(
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

test('events: ?limit=1001 is a 400 validation error (cap is 1000)', () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs/:id/events');
  assertHttpError(
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

test('events: 404 for an unknown run id (checked via getRun before listRunEvents)', () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs/:id/events');
  assertHttpError(
    () => route.handler(req({ params: { name: 'rajni', id: '999' } })),
    404,
    'not_found',
  );
  assert.equal(store.listRunEventsCalls.length, 0);
});

test('events: non-numeric id is a 400 validation error', () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), '/api/profiles/:name/runs/:id/events');
  assertHttpError(
    () => route.handler(req({ params: { name: 'rajni', id: 'abc' } })),
    400,
    'validation',
  );
});

test('events: null store (no local db) is a 404 no_local_db', () => {
  const route = findRoute(fakeSource(null), '/api/profiles/:name/runs/:id/events');
  assertHttpError(
    () => route.handler(req({ params: { name: 'notion-only', id: '7' } })),
    404,
    'no_local_db',
  );
});
