/**
 * routes.test.ts (config→db Phase 4, Task 9) — TDD for `makeConfigRoutes`.
 * Fakes are plain object literals (calls-recording closures), same pattern
 * as `features/board/routes.test.ts` — no `src/adapters/**` import.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSearchUrlsSaveReport,
  normalizeSearchUrlsDoc,
} from '../../../core/config/search_urls/index.ts';
import type { BoardProfile, BoardSource, DaemonStatus } from '../../../ports/board.ts';
import type { ConfigDocKey } from '../../../ports/config_store.ts';
import type { BoardRequest } from '../../shared/index.ts';
import { HttpError } from '../../shared/index.ts';
import { makeConfigRoutes } from './routes.ts';

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

interface FakeSourceOptions {
  profiles?: BoardProfile[];
  docs?: Partial<Record<ConfigDocKey, string>>;
  writeThrows?: Error;
  createThrows?: Error;
}

function fakeSource(opts: FakeSourceOptions = {}): BoardSource & {
  writeCalls: Array<{ name: string; doc: ConfigDocKey; rawText: string }>;
  createCalls: string[];
} {
  const profiles = opts.profiles ?? [{ name: 'rajni', connector: 'sqlite', hasDb: true }];
  const docs = new Map(Object.entries(opts.docs ?? {}));
  const writeCalls: Array<{ name: string; doc: ConfigDocKey; rawText: string }> = [];
  const createCalls: string[] = [];
  return {
    writeCalls,
    createCalls,
    listProfiles: async () => profiles,
    openStore: async () => null,
    readConfigDoc: async (name, doc) =>
      profiles.some((p) => p.name === name) ? docs.get(doc) : undefined,
    writeConfigDoc: async (name, doc, rawText) => {
      writeCalls.push({ name, doc, rawText });
      if (opts.writeThrows) throw opts.writeThrows;
      // Real shape (task 7's list): `search_urls.md` routes through the
      // actual normalize/report pipeline — same one `search_urls_save.ts`
      // calls — so the fake's return value and the doc stored for a later
      // GET are both the ACTUAL normalized text, not a raw echo. Every
      // other doc stays a byte-identical echo with no `report`.
      if (doc === 'search_urls.md') {
        const normalized = normalizeSearchUrlsDoc(rawText);
        const report = buildSearchUrlsSaveReport(normalized);
        docs.set(doc, normalized.text);
        return { text: normalized.text, report };
      }
      docs.set(doc, rawText);
      return { text: rawText };
    },
    createProfile: async (name) => {
      createCalls.push(name);
      if (opts.createThrows) throw opts.createThrows;
    },
    openIntents: async () => null,
    listSecrets: async () => ({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' }),
    writeSecret: async () => {},
    removeProfile: async () => ({ outcome: 'removed' }),
    runDoctor: async () => null,
    previewFilterRule: async () => ({ available: false, reason: 'no_recent_run' }),
    stopDaemon: async () => ({ outcome: 'stopped' }),
    startDaemon: async () => ({ outcome: 'started' }),
    setAutostart: async () => ({ outcome: 'ok' }),
    readDaemonStatus: async () => FAKE_DAEMON_STATUS,
    close() {},
  };
}

function findRoute(source: BoardSource, method: 'GET' | 'PUT' | 'POST', path: string) {
  const route = makeConfigRoutes(source).find(
    (r) => r.method === method && r.path === path,
  );
  assert.ok(route, `no route for ${method} ${path}`);
  return route;
}

// --- GET /api/profiles/:name/config/:doc ---

test('get: happy path returns { text }', async () => {
  const source = fakeSource({ docs: { 'profile.json': '{"connector":"sqlite"}' } });
  const route = findRoute(source, 'GET', '/api/profiles/:name/config/:doc');
  const res = await route.handler(
    req({ params: { name: 'rajni', doc: 'profile.json' } }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { text: '{"connector":"sqlite"}' });
});

test('get: :doc not one of VALID_DOCS is a 404 not_found', async () => {
  const source = fakeSource();
  const route = findRoute(source, 'GET', '/api/profiles/:name/config/:doc');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'rajni', doc: 'avoid.md' } })),
    404,
    'not_found',
  );
});

test('get: unknown :name is a 404 no_such_profile', async () => {
  const source = fakeSource();
  const route = findRoute(source, 'GET', '/api/profiles/:name/config/:doc');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'nope', doc: 'profile.json' } })),
    404,
    'no_such_profile',
  );
});

test('get: traversal probe on :name ("../rajni") is a 404 no_such_profile, never a fs escape', async () => {
  const source = fakeSource();
  const route = findRoute(source, 'GET', '/api/profiles/:name/config/:doc');
  await assertHttpError(
    () => route.handler(req({ params: { name: '../rajni', doc: 'profile.json' } })),
    404,
    'no_such_profile',
  );
});

test('get: traversal probe on :name ("a/../a") is a 404 no_such_profile', async () => {
  const source = fakeSource();
  const route = findRoute(source, 'GET', '/api/profiles/:name/config/:doc');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'a/../a', doc: 'profile.json' } })),
    404,
    'no_such_profile',
  );
});

test('get: doc not present for a real profile returns 200 with an empty draft, not a 404 (fix round — resume.json in particular must stay editable even though it is never seeded)', async () => {
  const source = fakeSource({ docs: {} });
  const route = findRoute(source, 'GET', '/api/profiles/:name/config/:doc');
  const res = await route.handler(req({ params: { name: 'rajni', doc: 'resume.json' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { text: '' });
});

// --- PUT /api/profiles/:name/config/:doc ---

test('put: happy path writes and echoes back { text } (report undefined for non-search_urls docs, dropped by JSON.stringify on the wire)', async () => {
  const source = fakeSource();
  const route = findRoute(source, 'PUT', '/api/profiles/:name/config/:doc');
  const res = await route.handler(
    req({
      params: { name: 'rajni', doc: 'filter.json' },
      body: { text: '{"locations":[]}' },
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { text: '{"locations":[]}', report: undefined });
  assert.deepEqual(source.writeCalls, [
    { name: 'rajni', doc: 'filter.json', rawText: '{"locations":[]}' },
  ]);
});

// AC5: a real misfiled+dirty search_urls.md save — a row filed under the
// WRONG page heading AND carrying an ephemeral query param — must (a) come
// back from PUT byte-identical to what a subsequent GET returns, and (b)
// carry a report whose total/refiled/cleaned/merged match what actually
// changed. Fixture mirrors ui/e2e/seed_misfiled_search_url.ts's rajni
// misfile shape, plus a `start` param to also exercise "cleaned".
const MISFILED_DIRTY_DOC =
  '# Search URLs\n\n## linkedin\n### linkedin__jobs-search\n' +
  '<!-- inventory: src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json -->\n' +
  '  • Acme DevOps - https://www.linkedin.com/jobs/search-results/?keywords=devops&location=Remote&start=25\n';

test('put: search_urls.md save response text is byte-identical to a subsequent GET', async () => {
  const source = fakeSource({ docs: { 'search_urls.md': MISFILED_DIRTY_DOC } });
  const putRoute = findRoute(source, 'PUT', '/api/profiles/:name/config/:doc');
  const getRoute = findRoute(source, 'GET', '/api/profiles/:name/config/:doc');
  const putRes = await putRoute.handler(
    req({
      params: { name: 'rajni', doc: 'search_urls.md' },
      body: { text: MISFILED_DIRTY_DOC },
    }),
  );
  const getRes = await getRoute.handler(
    req({ params: { name: 'rajni', doc: 'search_urls.md' } }),
  );
  assert.equal(putRes.status, 200);
  assert.equal(
    (putRes.body as { text: string }).text,
    (getRes.body as { text: string }).text,
  );
  // Not a no-op save — the raw input actually got refiled+cleaned, so a
  // byte-identical-to-the-raw-input assertion here would be vacuous.
  assert.notEqual((putRes.body as { text: string }).text, MISFILED_DIRTY_DOC);
});

test('put: search_urls.md save report.total/refiled/cleaned/merged match what changed', async () => {
  const source = fakeSource({ docs: { 'search_urls.md': MISFILED_DIRTY_DOC } });
  const route = findRoute(source, 'PUT', '/api/profiles/:name/config/:doc');
  const res = await route.handler(
    req({
      params: { name: 'rajni', doc: 'search_urls.md' },
      body: { text: MISFILED_DIRTY_DOC },
    }),
  );
  assert.equal(res.status, 200);
  const body = res.body as {
    text: string;
    report?: { total: number; refiled: number; cleaned: number; merged: number };
  };
  assert.ok(body.report);
  assert.deepEqual(
    {
      total: body.report.total,
      refiled: body.report.refiled,
      cleaned: body.report.cleaned,
      merged: body.report.merged,
    },
    { total: 1, refiled: 1, cleaned: 1, merged: 0 },
  );
});

test('put: a no-op search_urls.md save (already well-formed, no changes) returns report with all-zero change counts', async () => {
  // Derived from the real normalizer rather than hand-typed, so it's
  // guaranteed to be the canonical (self-fixed-point) serialization —
  // running it back through the same normalizer must be a true no-op.
  const wellFormed = normalizeSearchUrlsDoc(
    '# Search URLs\n\n## linkedin\n### linkedin__jobs-search-results\n' +
      '<!-- inventory: src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search-results.json -->\n' +
      '  • Acme DevOps - https://www.linkedin.com/jobs/search-results/?keywords=devops&location=Remote\n',
  ).text;
  const source = fakeSource({ docs: { 'search_urls.md': wellFormed } });
  const route = findRoute(source, 'PUT', '/api/profiles/:name/config/:doc');
  const res = await route.handler(
    req({ params: { name: 'rajni', doc: 'search_urls.md' }, body: { text: wellFormed } }),
  );
  assert.equal(res.status, 200);
  assert.equal((res.body as { text: string }).text, wellFormed);
  const report = (
    res.body as {
      report: { total: number; refiled: number; cleaned: number; merged: number };
    }
  ).report;
  assert.deepEqual(
    {
      total: report.total,
      refiled: report.refiled,
      cleaned: report.cleaned,
      merged: report.merged,
    },
    { total: 1, refiled: 0, cleaned: 0, merged: 0 },
  );
});

test('put: bad body shape (missing text) is a 400 validation', async () => {
  const source = fakeSource();
  const route = findRoute(source, 'PUT', '/api/profiles/:name/config/:doc');
  await assertHttpError(
    () =>
      route.handler(
        req({ params: { name: 'rajni', doc: 'filter.json' }, body: { wrong: 1 } }),
      ),
    400,
    'validation',
  );
});

test('put: :doc not valid is a 404 not_found, before body validation', async () => {
  const source = fakeSource();
  const route = findRoute(source, 'PUT', '/api/profiles/:name/config/:doc');
  await assertHttpError(
    () =>
      route.handler(
        req({ params: { name: 'rajni', doc: 'avoid.md' }, body: { text: 'x' } }),
      ),
    404,
    'not_found',
  );
});

test('put: unknown :name is a 404 no_such_profile', async () => {
  const source = fakeSource();
  const route = findRoute(source, 'PUT', '/api/profiles/:name/config/:doc');
  await assertHttpError(
    () =>
      route.handler(
        req({ params: { name: 'nope', doc: 'filter.json' }, body: { text: 'x' } }),
      ),
    404,
    'no_such_profile',
  );
});

test("put: writeConfigDoc throwing the validator's message surfaces as 422 verbatim", async () => {
  const source = fakeSource({
    writeThrows: new Error('profile.json is invalid: settings.sqlite.path is retired'),
  });
  const route = findRoute(source, 'PUT', '/api/profiles/:name/config/:doc');
  await assertHttpError(
    () =>
      route.handler(
        req({
          params: { name: 'rajni', doc: 'profile.json' },
          body: { text: '{"bad":true}' },
        }),
      ),
    422,
    'validation',
    'profile.json is invalid: settings.sqlite.path is retired',
  );
});

// --- POST /api/profiles ---

test('create: happy path returns 201 with a freshly seeded profile literal', async () => {
  const source = fakeSource();
  const route = findRoute(source, 'POST', '/api/profiles');
  const res = await route.handler(req({ body: { name: 'newprofile' } }));
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, {
    profile: { name: 'newprofile', connector: 'sqlite', hasDb: true },
  });
  assert.deepEqual(source.createCalls, ['newprofile']);
});

test('create: a name failing the zod regex is a 400, before ever calling the port', async () => {
  const source = fakeSource();
  const route = findRoute(source, 'POST', '/api/profiles');
  await assertHttpError(
    () => route.handler(req({ body: { name: 'Bad Name!' } })),
    400,
    'validation',
  );
  assert.deepEqual(source.createCalls, []);
});

test('create: a real duplicate is a 409 profile_exists', async () => {
  const source = fakeSource({
    createThrows: new Error('profile already exists: rajni'),
  });
  const route = findRoute(source, 'POST', '/api/profiles');
  await assertHttpError(
    () => route.handler(req({ body: { name: 'rajni' } })),
    409,
    'profile_exists',
    'profile already exists: rajni',
  );
});

test('create: an unexpected port throw propagates unchanged (never swallowed into a 409)', async () => {
  const source = fakeSource({ createThrows: new Error('disk full') });
  const route = findRoute(source, 'POST', '/api/profiles');
  await assert.rejects(
    async () => route.handler(req({ body: { name: 'newprofile' } })),
    (err: unknown) => {
      assert.ok(!(err instanceof HttpError));
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'disk full');
      return true;
    },
  );
});
