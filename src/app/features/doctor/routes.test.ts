/**
 * routes.test.ts (UI phase 1, Task 5) — TDD for `makeDoctorRoutes`. Fakes
 * are plain object literals (`fakeSource`), mirroring
 * `features/intents/routes.test.ts`'s pattern — no `src/adapters/**`
 * import anywhere in this file.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardSource, DaemonStatus } from '../../../ports/board.ts';
import type { DoctorReport } from '../../../ports/doctor.ts';
import type { BoardRequest } from '../../shared/index.ts';
import { HttpError } from '../../shared/index.ts';
import { makeDoctorRoutes } from './routes.ts';

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

const FAKE_DAEMON_STATUS: DaemonStatus = {
  state: 'stopped',
  pid: null,
  startedAt: null,
  lastTickAt: null,
  inFlight: null,
  profiles: [],
};

function fakeSource(runDoctor: BoardSource['runDoctor']): BoardSource {
  return {
    listProfiles: async () => [],
    openStore: async () => null,
    readConfigDoc: async () => undefined,
    writeConfigDoc: async () => {},
    createProfile: async () => {},
    runDoctor,
    readDaemonStatus: async () => FAKE_DAEMON_STATUS,
    openIntents: async () => null,
    listSecrets: async () => ({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' }),
    writeSecret: async () => {},
    close() {},
  };
}

test('makeDoctorRoutes: registers exactly one GET route at /api/profiles/:name/doctor', () => {
  const routes = makeDoctorRoutes(fakeSource(async () => null));
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.method, 'GET');
  assert.equal(routes[0]?.path, '/api/profiles/:name/doctor');
});

test("doctor: returns the report's status and findings", async () => {
  const report: DoctorReport = {
    findings: [{ check: 'home', status: 'ok', detail: '/tmp/home' }],
    status: 'ok',
  };
  const routes = makeDoctorRoutes(fakeSource(async () => report));
  const route = routes[0];
  assert.ok(route);
  const res = await route.handler(req({ params: { name: 'rajni' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok', findings: report.findings });
});

test('doctor: an unknown profile is a 404', async () => {
  const routes = makeDoctorRoutes(fakeSource(async () => null));
  const route = routes[0];
  assert.ok(route);
  await assertHttpError(
    () => route.handler(req({ params: { name: 'ghost' } })),
    404,
    'no_such_profile',
    'no such profile',
  );
});

test('doctor: a missing name param is a 400', async () => {
  const routes = makeDoctorRoutes(fakeSource(async () => null));
  const route = routes[0];
  assert.ok(route);
  await assertHttpError(
    () => route.handler(req({ params: {} })),
    400,
    'bad_request',
    'missing profile name',
  );
});
