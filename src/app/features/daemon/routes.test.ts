/**
 * routes.test.ts (UI phase 1, Task 7; settings-overhaul task 11 adds Stop,
 * task 12 adds Start) — TDD for `makeDaemonRoutes`. Fakes are plain object
 * literals (`fakeSource`), mirroring `features/doctor/routes.test.ts`'s
 * pattern — no `src/adapters/**` import anywhere in this file.
 *
 * The `stopDaemon`/`startDaemon` tests here cover the ROUTE's
 * outcome-to-HTTP mapping only (all `StopDaemonOutcome`/`StartDaemonOutcome`
 * values, via a stubbed `BoardSource.stopDaemon`/`startDaemon`) — the
 * actual kill-and-confirm / spawn-and-confirm sequencing is exercised
 * against the real implementations in `cli/wire/board_daemon_control.test.ts`,
 * the only layer with a stubbed process seam to assert it against. Per this
 * brief's own safety constraint, no test in this file (or in
 * `board_daemon_control.test.ts`) ever spawns, signals, or waits on a real
 * OS process.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  BoardSource,
  DaemonStatus,
  StartDaemonOutcome,
  StopDaemonOutcome,
} from '../../../ports/board.ts';
import type { BoardRequest } from '../../shared/index.ts';
import { makeDaemonRoutes } from './routes.ts';

function req(overrides: Partial<BoardRequest> = {}): BoardRequest {
  return { params: {}, query: new URLSearchParams(), body: undefined, ...overrides };
}

function fakeSource(overrides: Partial<BoardSource> = {}): BoardSource {
  return {
    listProfiles: async () => [],
    openStore: async () => null,
    readConfigDoc: async () => undefined,
    writeConfigDoc: async () => {},
    createProfile: async () => {},
    runDoctor: async () => null,
    previewFilterRule: async () => ({ available: false, reason: 'no_recent_run' }),
    readDaemonStatus: async () => defaultStatus(),
    stopDaemon: async () => ({ outcome: 'stopped' }),
    startDaemon: async () => ({ outcome: 'started' }),
    openIntents: async () => null,
    listSecrets: async () => ({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' }),
    writeSecret: async () => {},
    removeProfile: async () => ({ outcome: 'removed' }),
    close() {},
    ...overrides,
  };
}

function findRoute(source: BoardSource, method: 'GET' | 'POST', path: string) {
  const route = makeDaemonRoutes(source).find(
    (r) => r.method === method && r.path === path,
  );
  assert.ok(route, `no route for ${method} ${path}`);
  return route;
}

function defaultStatus(): DaemonStatus {
  return {
    state: 'running',
    pid: 4242,
    startedAt: '2026-08-07T00:00:00.000Z',
    lastTickAt: '2026-08-07T09:59:30.000Z',
    inFlight: { profile: 'rajni', pid: 4300, startedAt: '2026-08-07T09:59:00.000Z' },
    profiles: [
      {
        profile: 'harish',
        enabled: true,
        nextRunAt: '2026-08-08T03:30:00.000Z',
        degraded: false,
        degradedReason: null,
        schemaVersion: null,
        buildVersion: null,
      },
      {
        profile: 'rajni',
        enabled: false,
        nextRunAt: null,
        degraded: false,
        degradedReason: null,
        schemaVersion: null,
        buildVersion: null,
      },
    ],
  };
}

test('makeDaemonRoutes: registers exactly one GET and two POST routes', () => {
  const routes = makeDaemonRoutes(fakeSource());
  assert.equal(routes.length, 3);
  assert.ok(routes.some((r) => r.method === 'GET' && r.path === '/api/daemon'));
  assert.ok(routes.some((r) => r.method === 'POST' && r.path === '/api/daemon/stop'));
  assert.ok(routes.some((r) => r.method === 'POST' && r.path === '/api/daemon/start'));
});

test('daemon: returns the status verbatim', async () => {
  const status = defaultStatus();
  const route = findRoute(
    fakeSource({ readDaemonStatus: async () => status }),
    'GET',
    '/api/daemon',
  );
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
      {
        profile: 'rajni',
        enabled: true,
        nextRunAt: '2026-08-08T03:30:00.000Z',
        degraded: false,
        degradedReason: null,
        schemaVersion: null,
        buildVersion: null,
      },
    ],
  };
  const route = findRoute(
    fakeSource({ readDaemonStatus: async () => status }),
    'GET',
    '/api/daemon',
  );
  const res = await route.handler(req());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, status);
});

const OUTCOMES: Array<{ outcome: StopDaemonOutcome; expectedStatus: number }> = [
  { outcome: { outcome: 'stopped' }, expectedStatus: 200 },
  { outcome: { outcome: 'already_stopped' }, expectedStatus: 200 },
  { outcome: { outcome: 'daemon_unresponsive' }, expectedStatus: 409 },
  { outcome: { outcome: 'child_unresponsive', childPid: 5300 }, expectedStatus: 409 },
];

for (const { outcome, expectedStatus } of OUTCOMES) {
  test(`daemon stop: ${outcome.outcome} maps to ${expectedStatus} with the outcome as the body, no envelope`, async () => {
    const route = findRoute(
      fakeSource({ stopDaemon: async () => outcome }),
      'POST',
      '/api/daemon/stop',
    );
    const res = await route.handler(req());
    assert.equal(res.status, expectedStatus);
    assert.deepEqual(res.body, outcome);
  });
}

test('daemon stop: an unresponsive outcome never has status 200 (never reads as success)', async () => {
  for (const { outcome } of OUTCOMES.filter(
    (o) => o.outcome.outcome !== 'stopped' && o.outcome.outcome !== 'already_stopped',
  )) {
    const route = findRoute(
      fakeSource({ stopDaemon: async () => outcome }),
      'POST',
      '/api/daemon/stop',
    );
    const res = await route.handler(req());
    assert.notEqual(res.status, 200);
  }
});

test('daemon stop: a survived-SIGKILL daemon (daemon_unresponsive) never reports already_stopped', async () => {
  const route = findRoute(
    fakeSource({ stopDaemon: async () => ({ outcome: 'daemon_unresponsive' }) }),
    'POST',
    '/api/daemon/stop',
  );
  const res = await route.handler(req());
  assert.deepEqual(res.body, { outcome: 'daemon_unresponsive' });
  assert.notDeepEqual(res.body, { outcome: 'already_stopped' });
});

const START_OUTCOMES: Array<{ outcome: StartDaemonOutcome; expectedStatus: number }> = [
  { outcome: { outcome: 'started' }, expectedStatus: 200 },
  { outcome: { outcome: 'already_running' }, expectedStatus: 200 },
  { outcome: { outcome: 'spawn_failed' }, expectedStatus: 500 },
];

for (const { outcome, expectedStatus } of START_OUTCOMES) {
  test(`daemon start: ${outcome.outcome} maps to ${expectedStatus} with the outcome as the body, no envelope`, async () => {
    const route = findRoute(
      fakeSource({ startDaemon: async () => outcome }),
      'POST',
      '/api/daemon/start',
    );
    const res = await route.handler(req());
    assert.equal(res.status, expectedStatus);
    assert.deepEqual(res.body, outcome);
  });
}

test('daemon start: spawn_failed never has status 200 (never reads as success)', async () => {
  const route = findRoute(
    fakeSource({ startDaemon: async () => ({ outcome: 'spawn_failed' }) }),
    'POST',
    '/api/daemon/start',
  );
  const res = await route.handler(req());
  assert.notEqual(res.status, 200);
});

test('daemon start: a genuine spawn failure never reports already_running', async () => {
  const route = findRoute(
    fakeSource({ startDaemon: async () => ({ outcome: 'spawn_failed' }) }),
    'POST',
    '/api/daemon/start',
  );
  const res = await route.handler(req());
  assert.deepEqual(res.body, { outcome: 'spawn_failed' });
  assert.notDeepEqual(res.body, { outcome: 'already_running' });
});
