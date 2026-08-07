/**
 * routes.test.ts — TDD for `makeSecretsRoutes`. Fakes are plain object
 * literals (calls-recording closures), same pattern as
 * `features/board/routes.test.ts` — no `src/adapters/**` import anywhere
 * in this file.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  BoardSource,
  DaemonStatus,
  SecretKey,
  SecretPresence,
} from '../../../ports/board.ts';
import type { BoardRequest } from '../../shared/index.ts';
import { HttpError } from '../../shared/index.ts';
import { makeSecretsRoutes } from './routes.ts';

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

function fakeSource(presence: SecretPresence): BoardSource & {
  writeCalls: Array<{ key: SecretKey; value: string }>;
} {
  const writeCalls: Array<{ key: SecretKey; value: string }> = [];
  return {
    writeCalls,
    listProfiles: async () => [],
    openStore: async () => null,
    readConfigDoc: async () => undefined,
    writeConfigDoc: async () => {},
    createProfile: async () => {},
    openIntents: async () => null,
    listSecrets: async () => presence,
    writeSecret: async (key, value) => {
      writeCalls.push({ key, value });
    },
    removeProfile: async () => ({ outcome: 'removed' }),
    runDoctor: async () => null,
    readDaemonStatus: async () => FAKE_DAEMON_STATUS,
    close() {},
  };
}

function findRoute(source: BoardSource, method: 'GET' | 'PUT', path: string) {
  const route = makeSecretsRoutes(source).find(
    (r) => r.method === method && r.path === path,
  );
  assert.ok(route, `no route for ${method} ${path}`);
  return route;
}

const PRESENCE: SecretPresence = {
  NOTION_TOKEN: 'present',
  TELEGRAM_BOT_TOKEN: 'absent',
};

test('makeSecretsRoutes: registers GET /api/secrets and PUT /api/secrets/:key', () => {
  const routes = makeSecretsRoutes(fakeSource(PRESENCE));
  assert.equal(routes.length, 2);
  assert.equal(routes[0]?.method, 'GET');
  assert.equal(routes[0]?.path, '/api/secrets');
  assert.equal(routes[1]?.method, 'PUT');
  assert.equal(routes[1]?.path, '/api/secrets/:key');
});

test('GET /api/secrets returns presence only', async () => {
  const route = findRoute(fakeSource(PRESENCE), 'GET', '/api/secrets');
  const res = await route.handler(req());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { NOTION_TOKEN: 'present', TELEGRAM_BOT_TOKEN: 'absent' });
});

test('PUT: an allowlisted key writes and reports present', async () => {
  const source = fakeSource(PRESENCE);
  const route = findRoute(source, 'PUT', '/api/secrets/:key');
  const res = await route.handler(
    req({ params: { key: 'NOTION_TOKEN' }, body: { value: 'secret-value' } }),
  );
  assert.deepEqual(source.writeCalls, [{ key: 'NOTION_TOKEN', value: 'secret-value' }]);
  assert.deepEqual(res, {
    status: 200,
    body: { key: 'NOTION_TOKEN', status: 'present' },
  });
});

test('PUT: TELEGRAM_BOT_TOKEN is also allowlisted', async () => {
  const source = fakeSource(PRESENCE);
  const route = findRoute(source, 'PUT', '/api/secrets/:key');
  const res = await route.handler(
    req({ params: { key: 'TELEGRAM_BOT_TOKEN' }, body: { value: 'tok' } }),
  );
  assert.deepEqual(source.writeCalls, [{ key: 'TELEGRAM_BOT_TOKEN', value: 'tok' }]);
  assert.deepEqual(res, {
    status: 200,
    body: { key: 'TELEGRAM_BOT_TOKEN', status: 'present' },
  });
});

test('PUT: an unknown key is a 404 and never reaches the source', async () => {
  const source = fakeSource(PRESENCE);
  const route = findRoute(source, 'PUT', '/api/secrets/:key');
  await assertHttpError(
    () =>
      route.handler(
        req({ params: { key: 'OPENAI_API_KEY' }, body: { value: 'sk-whatever' } }),
      ),
    404,
    'unknown_secret',
    'unknown secret key',
  );
  assert.equal(source.writeCalls.length, 0);
});

test('PUT: a missing or empty value is a 400 with a fixed message', async () => {
  const source = fakeSource(PRESENCE);
  const route = findRoute(source, 'PUT', '/api/secrets/:key');
  await assertHttpError(
    () => route.handler(req({ params: { key: 'NOTION_TOKEN' }, body: {} })),
    400,
    'validation',
    'value must be a non-empty string',
  );
  await assertHttpError(
    () => route.handler(req({ params: { key: 'NOTION_TOKEN' }, body: { value: '' } })),
    400,
    'validation',
    'value must be a non-empty string',
  );
  assert.equal(source.writeCalls.length, 0);
});

test('PUT: a value containing a newline is rejected', async () => {
  const source = fakeSource(PRESENCE);
  const route = findRoute(source, 'PUT', '/api/secrets/:key');
  await assertHttpError(
    () =>
      route.handler(req({ params: { key: 'NOTION_TOKEN' }, body: { value: 'a\nb' } })),
    400,
    'validation',
    'value must not contain a newline',
  );
  assert.equal(source.writeCalls.length, 0);
});

test('PUT: a value containing a quote is rejected with the fixed message and never written', async () => {
  const source = fakeSource(PRESENCE);
  const route = findRoute(source, 'PUT', '/api/secrets/:key');
  await assertHttpError(
    () =>
      route.handler(req({ params: { key: 'NOTION_TOKEN' }, body: { value: 'sk-"abc' } })),
    400,
    'validation',
    'secret value must not contain quotes, backticks, or backslashes',
  );
  assert.equal(source.writeCalls.length, 0);
});

test('PUT: a value containing a backslash is rejected with the fixed message and never written', async () => {
  const source = fakeSource(PRESENCE);
  const route = findRoute(source, 'PUT', '/api/secrets/:key');
  await assertHttpError(
    () =>
      route.handler(
        req({ params: { key: 'NOTION_TOKEN' }, body: { value: 'sk-\\nabc' } }),
      ),
    400,
    'validation',
    'secret value must not contain quotes, backticks, or backslashes',
  );
  assert.equal(source.writeCalls.length, 0);
});

test('PUT: a value containing a backtick is rejected with the fixed message and never written', async () => {
  const source = fakeSource(PRESENCE);
  const route = findRoute(source, 'PUT', '/api/secrets/:key');
  await assertHttpError(
    () =>
      route.handler(req({ params: { key: 'NOTION_TOKEN' }, body: { value: 'sk-`abc' } })),
    400,
    'validation',
    'secret value must not contain quotes, backticks, or backslashes',
  );
  assert.equal(source.writeCalls.length, 0);
});

test('PUT: a value wrapped first-and-last in backticks is rejected (dotenvs third quote-delimiter form)', async () => {
  const source = fakeSource(PRESENCE);
  const route = findRoute(source, 'PUT', '/api/secrets/:key');
  await assertHttpError(
    () =>
      route.handler(
        req({ params: { key: 'NOTION_TOKEN' }, body: { value: '`sk-abc123`' } }),
      ),
    400,
    'validation',
    'secret value must not contain quotes, backticks, or backslashes',
  );
  assert.equal(source.writeCalls.length, 0);
});

test('PUT: no error message or response body ever contains the submitted value', async () => {
  const SECRET = 'SUPER-SECRET-abc123';
  const cases: Array<{ params: Record<string, string>; body: unknown }> = [
    { params: { key: 'OPENAI_API_KEY' }, body: { value: SECRET } },
    { params: { key: 'NOTION_TOKEN' }, body: {} },
    { params: { key: 'NOTION_TOKEN' }, body: { value: '' } },
    { params: { key: 'NOTION_TOKEN' }, body: { value: `${SECRET}\n` } },
    { params: { key: 'NOTION_TOKEN' }, body: { value: `${SECRET}"` } },
    { params: { key: 'NOTION_TOKEN' }, body: { value: `${SECRET}\\` } },
    { params: { key: 'NOTION_TOKEN' }, body: { value: `${SECRET}\`` } },
  ];
  for (const c of cases) {
    const source = fakeSource(PRESENCE);
    const route = findRoute(source, 'PUT', '/api/secrets/:key');
    await assert.rejects(
      async () => route.handler(req({ params: c.params, body: c.body })),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.ok(!JSON.stringify(err.message).includes('SUPER-SECRET'));
        return true;
      },
    );
  }

  // The happy path's response body also never echoes the value.
  const source = fakeSource(PRESENCE);
  const route = findRoute(source, 'PUT', '/api/secrets/:key');
  const res = await route.handler(
    req({ params: { key: 'NOTION_TOKEN' }, body: { value: SECRET } }),
  );
  assert.ok(!JSON.stringify(res.body).includes('SUPER-SECRET'));
});
