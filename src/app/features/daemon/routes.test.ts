/**
 * routes.test.ts (UI phase 1, Task 7) — TDD for `makeDaemonRoutes`. Fakes
 * are plain object literals (`fakeSource`), mirroring
 * `features/doctor/routes.test.ts`'s pattern — no `src/adapters/**` import
 * anywhere in this file.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardSource, DaemonStatus } from '../../../ports/board.ts';
import type { BoardRequest } from '../../shared/index.ts';
import { makeDaemonRoutes } from './routes.ts';

function req(overrides: Partial<BoardRequest> = {}): BoardRequest {
  return { params: {}, query: new URLSearchParams(), body: undefined, ...overrides };
}

function fakeSource(readDaemonStatus: BoardSource['readDaemonStatus']): BoardSource {
  return {
    listProfiles: async () => [],
    openStore: async () => null,
    readConfigDoc: async () => undefined,
    writeConfigDoc: async () => {},
    createProfile: async () => {},
    runDoctor: async () => null,
    readDaemonStatus,
    openIntents: async () => null,
    listSecrets: async () => ({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' }),
    writeSecret: async () => {},
    removeProfile: async () => ({ outcome: 'removed' }),
    close() {},
  };
}

function findRoute(source: BoardSource) {
  const route = makeDaemonRoutes(source).find(
    (r) => r.method === 'GET' && r.path === '/api/daemon',
  );
  assert.ok(route, 'no route for GET /api/daemon');
  return route;
}

test('makeDaemonRoutes: registers exactly one GET route at /api/daemon', () => {
  const routes = makeDaemonRoutes(fakeSource(async () => defaultStatus()));
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.method, 'GET');
  assert.equal(routes[0]?.path, '/api/daemon');
});

function defaultStatus(): DaemonStatus {
  return {
    state: 'running',
    pid: 4242,
    startedAt: '2026-08-07T00:00:00.000Z',
    lastTickAt: '2026-08-07T09:59:30.000Z',
    inFlight: { profile: 'rajni', pid: 4300, startedAt: '2026-08-07T09:59:00.000Z' },
    profiles: [
      { profile: 'harish', enabled: true, nextRunAt: '2026-08-08T03:30:00.000Z' },
      { profile: 'rajni', enabled: false, nextRunAt: null },
    ],
  };
}

test('daemon: returns the status verbatim', async () => {
  const status = defaultStatus();
  const route = findRoute(fakeSource(async () => status));
  const res = await route.handler(req());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, status);
});

test('daemon: a stopped daemon reports nulls and still lists profiles', async () => {
  const status: DaemonStatus = {
    state: 'stopped',
    pid: null,
    startedAt: null,
    lastTickAt: null,
    inFlight: null,
    profiles: [
      { profile: 'rajni', enabled: true, nextRunAt: '2026-08-08T03:30:00.000Z' },
    ],
  };
  const route = findRoute(fakeSource(async () => status));
  const res = await route.handler(req());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, status);
});
