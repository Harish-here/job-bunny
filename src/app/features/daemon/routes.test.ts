/**
 * routes.test.ts (UI phase 1, Task 7; settings-overhaul task 11 adds Stop,
 * task 12 adds Start, task 13 adds Autostart) — TDD for `makeDaemonRoutes`.
 * Fakes are plain object literals (`fakeSource`), mirroring
 * `features/doctor/routes.test.ts`'s pattern — no `src/adapters/**` import
 * anywhere in this file.
 *
 * The `stopDaemon`/`startDaemon`/`setAutostart` tests here cover the
 * ROUTE's outcome-to-HTTP mapping only (all `StopDaemonOutcome`/
 * `StartDaemonOutcome`/`AutostartOutcome` values, via a stubbed
 * `BoardSource.stopDaemon`/`startDaemon`/`setAutostart`) — the actual
 * kill-and-confirm / spawn-and-confirm / enable-and-disable sequencing is
 * exercised against the real implementations in
 * `cli/wire/board_daemon_control.test.ts`, the only layer with a stubbed
 * process/platform seam to assert it against. Per this brief's own safety
 * constraint, no test in this file (or in `board_daemon_control.test.ts`)
 * ever spawns, signals, waits on, or exercises the real darwin path of an
 * OS process.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AutostartOutcome,
  BoardSource,
  DaemonStatus,
  StartDaemonOutcome,
  StopDaemonOutcome,
} from '../../../ports/board.ts';
import type { BoardRequest } from '../../shared/index.ts';
import { HttpError } from '../../shared/index.ts';
import { makeDaemonRoutes } from './routes.ts';

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
    setAutostart: async () => ({ outcome: 'ok' }),
    openIntents: async () => null,
    listSecrets: async () => ({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' }),
    writeSecret: async () => {},
    removeProfile: async () => ({ outcome: 'removed' }),
    close() {},
    ...overrides,
  };
}

function findRoute(source: BoardSource, method: 'GET' | 'POST' | 'PUT', path: string) {
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

test('makeDaemonRoutes: registers exactly one GET, two POST, and one PUT route', () => {
  const routes = makeDaemonRoutes(fakeSource());
  assert.equal(routes.length, 4);
  assert.ok(routes.some((r) => r.method === 'GET' && r.path === '/api/daemon'));
  assert.ok(routes.some((r) => r.method === 'POST' && r.path === '/api/daemon/stop'));
  assert.ok(routes.some((r) => r.method === 'POST' && r.path === '/api/daemon/start'));
  assert.ok(routes.some((r) => r.method === 'PUT' && r.path === '/api/daemon/autostart'));
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
  { outcome: { outcome: 'stale_pidfile' }, expectedStatus: 409 },
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

// --- daemon autostart (task 13) -------------------------------------------

const AUTOSTART_OUTCOMES: AutostartOutcome[] = [
  { outcome: 'ok' },
  { outcome: 'unsupported_platform' },
];

for (const outcome of AUTOSTART_OUTCOMES) {
  test(`daemon autostart PUT enabled:true: ${outcome.outcome} maps to 200 with the outcome as the body, no envelope`, async () => {
    let received: boolean | undefined;
    const route = findRoute(
      fakeSource({
        setAutostart: async (enabled) => {
          received = enabled;
          return outcome;
        },
      }),
      'PUT',
      '/api/daemon/autostart',
    );
    const res = await route.handler(req({ body: { enabled: true } }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, outcome);
    assert.equal(received, true);
  });
}

test('daemon autostart PUT enabled:false: forwards false through to BoardSource.setAutostart', async () => {
  let received: boolean | undefined;
  const route = findRoute(
    fakeSource({
      setAutostart: async (enabled) => {
        received = enabled;
        return { outcome: 'ok' };
      },
    }),
    'PUT',
    '/api/daemon/autostart',
  );
  const res = await route.handler(req({ body: { enabled: false } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { outcome: 'ok' });
  assert.equal(received, false);
});

test('daemon autostart PUT: a non-boolean enabled field is rejected before reaching BoardSource', async () => {
  let called = false;
  const route = findRoute(
    fakeSource({
      setAutostart: async () => {
        called = true;
        return { outcome: 'ok' };
      },
    }),
    'PUT',
    '/api/daemon/autostart',
  );
  await assert.rejects(async () => {
    await route.handler(req({ body: { enabled: 'yes' } }));
  });
  assert.equal(called, false);
});

test('daemon autostart PUT: a missing body is rejected before reaching BoardSource', async () => {
  let called = false;
  const route = findRoute(
    fakeSource({
      setAutostart: async () => {
        called = true;
        return { outcome: 'ok' };
      },
    }),
    'PUT',
    '/api/daemon/autostart',
  );
  await assert.rejects(async () => {
    await route.handler(req({ body: undefined }));
  });
  assert.equal(called, false);
});

test('daemon autostart PUT: a thrown HttpError(409, autostart_conflict) from BoardSource.setAutostart propagates through the handler unchanged (fix round F13 — a legacy-plist conflict must never be swallowed by a future try/catch)', async () => {
  const route = findRoute(
    fakeSource({
      setAutostart: async () => {
        throw new HttpError(
          409,
          'autostart_conflict',
          'launchctl: service already loaded',
        );
      },
    }),
    'PUT',
    '/api/daemon/autostart',
  );
  await assertHttpError(
    () => route.handler(req({ body: { enabled: true } })),
    409,
    'autostart_conflict',
    'launchctl: service already loaded',
  );
});
