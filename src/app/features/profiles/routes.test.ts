import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  BoardProfile,
  BoardSource,
  DaemonStatus,
  RemoveProfileOutcome,
} from '../../../ports/board.ts';
import type { BoardRequest } from '../../shared/index.ts';
import { HttpError } from '../../shared/index.ts';
import { makeProfilesRoutes } from './routes.ts';

const PROFILES: BoardProfile[] = [
  { name: 'rajni', connector: 'sqlite', hasDb: true },
  { name: 'harish', connector: 'notion', hasDb: false },
];

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

function fakeSource(
  removeProfile: BoardSource['removeProfile'] = async () => ({ outcome: 'removed' }),
): BoardSource {
  return {
    listProfiles: async () => PROFILES,
    openStore: async () => null,
    readConfigDoc: async () => undefined,
    writeConfigDoc: async () => {},
    createProfile: async () => {},
    openIntents: async () => null,
    listSecrets: async () => ({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' }),
    writeSecret: async () => {},
    removeProfile,
    runDoctor: async () => null,
    readDaemonStatus: async () => FAKE_DAEMON_STATUS,
    close() {},
  };
}

function findRoute(source: BoardSource, method: 'GET' | 'DELETE', path: string) {
  const route = makeProfilesRoutes(source).find(
    (r) => r.method === method && r.path === path,
  );
  assert.ok(route, `no route for ${method} ${path}`);
  return route;
}

test('GET /api/profiles returns listProfiles() verbatim', async () => {
  const routes = makeProfilesRoutes(fakeSource());
  assert.equal(routes.length, 2);
  const route = routes[0];
  assert.ok(route);
  assert.equal(route.method, 'GET');
  assert.equal(route.path, '/api/profiles');
  const res = await route.handler({
    params: {},
    query: new URLSearchParams(),
    body: undefined,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { profiles: PROFILES });
});

test('makeProfilesRoutes: registers GET /api/profiles and DELETE /api/profiles/:name', () => {
  const routes = makeProfilesRoutes(fakeSource());
  assert.equal(routes.length, 2);
  assert.equal(routes[0]?.method, 'GET');
  assert.equal(routes[0]?.path, '/api/profiles');
  assert.equal(routes[1]?.method, 'DELETE');
  assert.equal(routes[1]?.path, '/api/profiles/:name');
});

test('DELETE: a removable profile returns removed with its name', async () => {
  const route = findRoute(
    fakeSource(async () => ({ outcome: 'removed' })),
    'DELETE',
    '/api/profiles/:name',
  );
  const res = await route.handler(req({ params: { name: 'scratchpad' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { removed: true, name: 'scratchpad' });
});

test('DELETE: an unknown profile is a 404', async () => {
  const route = findRoute(
    fakeSource(async () => ({ outcome: 'not_found' })),
    'DELETE',
    '/api/profiles/:name',
  );
  await assertHttpError(
    () => route.handler(req({ params: { name: 'ghost' } })),
    404,
    'no_such_profile',
    'no such profile',
  );
});

test('DELETE: rajni is refused', async () => {
  const removeProfile: BoardSource['removeProfile'] = async (name) => {
    assert.equal(name, 'rajni');
    return { outcome: 'protected' };
  };
  const route = findRoute(fakeSource(removeProfile), 'DELETE', '/api/profiles/:name');
  await assertHttpError(
    () => route.handler(req({ params: { name: 'rajni' } })),
    409,
    'protected_profile',
    '"rajni" is a protected fixture profile',
  );
});

test('DELETE: a running run blocks with the run id', async () => {
  const outcome: RemoveProfileOutcome = { outcome: 'run_in_progress', runId: 42 };
  const route = findRoute(
    fakeSource(async () => outcome),
    'DELETE',
    '/api/profiles/:name',
  );
  const res = await route.handler(req({ params: { name: 'scratchpad' } }));
  assert.deepEqual(res, {
    status: 409,
    body: {
      error: {
        code: 'run_in_progress',
        message: 'a run is in progress for this profile',
        runId: 42,
      },
    },
  });
});

test('DELETE: a pending intent blocks with the intent id', async () => {
  const outcome: RemoveProfileOutcome = { outcome: 'intent_pending', intentId: 9 };
  const route = findRoute(
    fakeSource(async () => outcome),
    'DELETE',
    '/api/profiles/:name',
  );
  const res = await route.handler(req({ params: { name: 'scratchpad' } }));
  assert.deepEqual(res, {
    status: 409,
    body: {
      error: {
        code: 'intent_pending',
        message: 'a queued run intent is still pending for this profile',
        intentId: 9,
      },
    },
  });
});

test('DELETE: a missing name param is a 400', async () => {
  const route = findRoute(fakeSource(), 'DELETE', '/api/profiles/:name');
  await assertHttpError(
    () => route.handler(req({ params: {} })),
    400,
    'bad_request',
    'missing profile name',
  );
});
