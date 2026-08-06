/**
 * routes.test.ts (local-DB spec PR 4, Task 5) — TDD for `makeBoardRoutes`.
 * Fakes are plain object literals (calls-recording closures) per
 * `migrate.test.ts`'s pattern — no `src/adapters/**` import anywhere in
 * this file.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  BoardJobDetail,
  BoardJobRow,
  BoardQuery,
  BoardSource,
  BoardStore,
  TrackingPatch,
  TrackingRow,
} from '../../../ports/board.ts';
import type { BoardRequest } from '../../shared/index.ts';
import { HttpError } from '../../shared/index.ts';
import { makeBoardRoutes } from './routes.ts';

function req(overrides: Partial<BoardRequest> = {}): BoardRequest {
  return { params: {}, query: new URLSearchParams(), body: undefined, ...overrides };
}

/** Routes throw `HttpError`; the server (Task 6) is what turns the throw
 * into a JSON envelope. Asserting the rejection here — rather than a
 * resolved response — keeps this slice's tests honest about that
 * boundary. `fn()` returns a `Promise` (every handler is `async` now that
 * `openStoreOrThrow` awaits the `BoardSource` port), so a synchronous
 * `assert.throws` can never observe the throw — it surfaces only as a
 * rejection. */
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

const SAMPLE_ROW: BoardJobRow = {
  id: 'li-1',
  lane: 'linkedin',
  title: 'Staff Frontend Engineer',
  company: 'Acme Corp',
  url: 'https://www.linkedin.com/jobs/view/1',
  seniority: 'staff',
  locationCity: 'Remote',
  workType: 'remote',
  timezone: null,
  skills: ['react'],
  excitement: 'Vera level',
  score: 90,
  matchReasons: ['skills match'],
  reviewFlags: [],
  dateFound: '2026-07-01T00:00:00.000Z',
  archived: false,
  tracking: null,
};

const SAMPLE_DETAIL: BoardJobDetail = {
  ...SAMPLE_ROW,
  jd: {
    identity: {
      id: 'li-1',
      lane: 'linkedin',
      url: 'https://www.linkedin.com/jobs/view/1',
      company: 'Acme Corp',
      title: 'Staff Frontend Engineer',
      scrapedAt: '2026-07-01T00:00:00.000Z',
    },
  },
};

const SAMPLE_TRACKING: TrackingRow = {
  jobId: 'li-1',
  updatedAt: '2026-08-02T00:00:00.000Z',
  status: 'Applied',
};

function fakeStore(overrides: Partial<BoardStore> = {}): BoardStore & {
  listCalls: BoardQuery[];
  patchCalls: Array<{ id: string; patch: TrackingPatch; now: string }>;
} {
  const listCalls: BoardQuery[] = [];
  const patchCalls: Array<{ id: string; patch: TrackingPatch; now: string }> = [];
  return {
    listCalls,
    patchCalls,
    listJobs(query) {
      listCalls.push(query);
      return { rows: [SAMPLE_ROW], total: 1 };
    },
    getJob(id) {
      return id === SAMPLE_ROW.id ? SAMPLE_DETAIL : null;
    },
    updateTracking(id, patch, now) {
      patchCalls.push({ id, patch, now });
      return id === SAMPLE_ROW.id ? SAMPLE_TRACKING : null;
    },
    listRuns: () => ({ rows: [], total: 0 }),
    getRun: () => null,
    listRunEvents: () => ({ rows: [], total: 0 }),
    close() {},
    ...overrides,
  };
}

/** `listProfiles()` always names its one profile 'rajni' with a `sqlite`
 * connector when `store` is non-null — every non-null-store test below
 * requests `name: 'rajni'`, matching `openStoreOrThrow`'s new
 * connector-gate lookup. `store === null` (the "no profile"/"unknown
 * profile" cases) keeps `listProfiles()` empty, same as before. */
function fakeSource(store: BoardStore | null, connector = 'sqlite'): BoardSource {
  return {
    listProfiles: async () => (store ? [{ name: 'rajni', connector, hasDb: true }] : []),
    openStore: async () => store,
    close() {},
  };
}

function findRoute(source: BoardSource, method: 'GET' | 'PATCH', path: string) {
  const route = makeBoardRoutes(source).find(
    (r) => r.method === method && r.path === path,
  );
  assert.ok(route, `no route for ${method} ${path}`);
  return route;
}

// --- GET /api/profiles/:name/jobs ---

test('list: happy path with defaults', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), 'GET', '/api/profiles/:name/jobs');
  const res = await route.handler(req({ params: { name: 'rajni' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { rows: [SAMPLE_ROW], total: 1, limit: 50, offset: 0 });
  assert.equal(store.listCalls[0]?.status, undefined);
  assert.equal(store.listCalls[0]?.archived, false);
});

test('list: ?status=Applied reaches the store as { status, archived: false, ... }', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), 'GET', '/api/profiles/:name/jobs');
  await route.handler(
    req({ params: { name: 'rajni' }, query: new URLSearchParams({ status: 'Applied' }) }),
  );
  assert.equal(store.listCalls.length, 1);
  assert.deepEqual(store.listCalls[0], {
    status: 'Applied',
    excitement: undefined,
    company: undefined,
    dateFrom: undefined,
    dateTo: undefined,
    archived: false,
    sort: undefined,
    order: undefined,
    limit: undefined,
    offset: undefined,
  });
});

test('list: ?archived=true maps to boolean true', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), 'GET', '/api/profiles/:name/jobs');
  await route.handler(
    req({ params: { name: 'rajni' }, query: new URLSearchParams({ archived: 'true' }) }),
  );
  assert.equal(store.listCalls[0]?.archived, true);
});

test('list: ?limit=999 is a 400 validation error', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store), 'GET', '/api/profiles/:name/jobs');
  await assertHttpError(
    () =>
      route.handler(
        req({ params: { name: 'rajni' }, query: new URLSearchParams({ limit: '999' }) }),
      ),
    400,
    'validation',
  );
  assert.equal(store.listCalls.length, 0);
});

test('list: null store (no local db) is a 404 no_local_db', async () => {
  const route = findRoute(fakeSource(null), 'GET', '/api/profiles/:name/jobs');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'notion-only' } })),
    404,
    'no_local_db',
    'profile has no local database (pure-Notion profiles are read via Notion)',
  );
});

test('list: an OPENABLE store on a notion-connector profile is still a 404 no_local_db, never an empty 200 (local-DB spec D5: hasDb no longer implies connector === sqlite)', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store, 'notion'), 'GET', '/api/profiles/:name/jobs');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'rajni' } })),
    404,
    'no_local_db',
    'profile has no local database (pure-Notion profiles are read via Notion)',
  );
  assert.equal(store.listCalls.length, 0);
});

test('list: an UNKNOWN connector ("") falls through to the openStore/hasDb gate — an openable store is a 200, not a 404 (a corrupt profile.json must not hide an intact jobbunny.db)', async () => {
  const store = fakeStore();
  const route = findRoute(fakeSource(store, ''), 'GET', '/api/profiles/:name/jobs');
  const res = await route.handler(req({ params: { name: 'rajni' } }));
  assert.equal(res.status, 200);
  assert.equal(store.listCalls.length, 1);
});

test('list: an UNKNOWN connector ("") with no openable store still 404s no_local_db', async () => {
  const source: BoardSource = {
    listProfiles: async () => [{ name: 'rajni', connector: '', hasDb: false }],
    openStore: async () => null,
    close() {},
  };
  const route = findRoute(source, 'GET', '/api/profiles/:name/jobs');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'rajni' } })),
    404,
    'no_local_db',
  );
});

// --- GET /api/profiles/:name/jobs/:id ---

test('get: 200 for a known id', async () => {
  const route = findRoute(fakeSource(fakeStore()), 'GET', '/api/profiles/:name/jobs/:id');
  const res = await route.handler(req({ params: { name: 'rajni', id: 'li-1' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, SAMPLE_DETAIL);
});

test('get: 404 for an unknown id', async () => {
  const route = findRoute(fakeSource(fakeStore()), 'GET', '/api/profiles/:name/jobs/:id');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'rajni', id: 'nope' } })),
    404,
    'not_found',
  );
});

test('get: null store is a 404 no_local_db', async () => {
  const route = findRoute(fakeSource(null), 'GET', '/api/profiles/:name/jobs/:id');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'notion-only', id: 'li-1' } })),
    404,
    'no_local_db',
  );
});

// --- PATCH /api/profiles/:name/jobs/:id/tracking ---

test('patch: happy path — fake returns row, now is an ISO string arg', async () => {
  const store = fakeStore();
  const route = findRoute(
    fakeSource(store),
    'PATCH',
    '/api/profiles/:name/jobs/:id/tracking',
  );
  const res = await route.handler(
    req({ params: { name: 'rajni', id: 'li-1' }, body: { status: 'Applied' } }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { tracking: SAMPLE_TRACKING });
  assert.equal(store.patchCalls.length, 1);
  const call = store.patchCalls[0];
  assert.ok(call);
  assert.equal(call.id, 'li-1');
  assert.deepEqual(call.patch, { status: 'Applied' });
  assert.match(call.now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('patch: {} is a 400 (empty patch refinement)', async () => {
  const store = fakeStore();
  const route = findRoute(
    fakeSource(store),
    'PATCH',
    '/api/profiles/:name/jobs/:id/tracking',
  );
  await assertHttpError(
    () => route.handler(req({ params: { name: 'rajni', id: 'li-1' }, body: {} })),
    400,
    'validation',
  );
  assert.equal(store.patchCalls.length, 0);
});

test('patch: an unknown field is a 400 (strictObject)', async () => {
  const store = fakeStore();
  const route = findRoute(
    fakeSource(store),
    'PATCH',
    '/api/profiles/:name/jobs/:id/tracking',
  );
  await assertHttpError(
    () =>
      route.handler(req({ params: { name: 'rajni', id: 'li-1' }, body: { bogus: 'x' } })),
    400,
    'validation',
  );
  assert.equal(store.patchCalls.length, 0);
});

test('patch: a bare "" string field is a 400 (min(1) — clearing is null, not "")', async () => {
  const store = fakeStore();
  const route = findRoute(
    fakeSource(store),
    'PATCH',
    '/api/profiles/:name/jobs/:id/tracking',
  );
  await assertHttpError(
    () =>
      route.handler(req({ params: { name: 'rajni', id: 'li-1' }, body: { notes: '' } })),
    400,
    'validation',
  );
  assert.equal(store.patchCalls.length, 0);
});

test('patch: null store (no local db) is a 404 no_local_db', async () => {
  const route = findRoute(
    fakeSource(null),
    'PATCH',
    '/api/profiles/:name/jobs/:id/tracking',
  );
  await assertHttpError(
    () =>
      route.handler(
        req({ params: { name: 'notion-only', id: 'li-1' }, body: { status: 'Applied' } }),
      ),
    404,
    'no_local_db',
  );
});

// --- GET /api/profiles/:name/meta ---

test('meta: lists both vocabularies without ever touching the store', async () => {
  const source: BoardSource = {
    listProfiles: async () => [],
    openStore: async () => {
      throw new Error('meta must not open a store');
    },
    close() {},
  };
  const route = findRoute(source, 'GET', '/api/profiles/:name/meta');
  const res = await route.handler(req({ params: { name: 'rajni' } }));
  assert.equal(res.status, 200);
  const body = res.body as { statusOptions: string[]; excitementOptions: string[] };
  assert.ok(body.statusOptions.includes('Applied'));
  assert.ok(body.excitementOptions.includes('Vera level'));
});

test('meta: returns 200 even for an unknown profile name (vocab is profile-independent)', async () => {
  const source: BoardSource = {
    listProfiles: async () => [],
    openStore: async () => {
      throw new Error('meta must not open a store');
    },
    close() {},
  };
  const route = findRoute(source, 'GET', '/api/profiles/:name/meta');
  const res = await route.handler(req({ params: { name: 'does-not-exist' } }));
  assert.equal(res.status, 200);
});
