/**
 * server.test.ts (local-DB spec PR 4, Task 6) — the repo's first socket
 * test. Real `fetch` against `listen(0)` (the plan's primary transport);
 * if a sandbox ever blocks loopback `fetch`, the documented fallback is
 * `node:http`'s `http.request` against the same `127.0.0.1:<port>` — see
 * `server.ts`'s file header. Every test closes the server in a `finally`.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { z } from 'zod';
import type { PERSONA_CATALOG } from '../../core/personas/index.ts';
import type {
  BoardProfile,
  BoardSource,
  BoardStore,
  DaemonStatus,
  TrackingPatch,
} from '../../ports/board.ts';
import type { LogData, Logger } from '../../ports/context.ts';
import type { RunIntent, RunIntentStore } from '../../ports/run_intents.ts';
import { createBoardServer } from './server.ts';

/** Sends a raw request line/headers over a plain TCP socket and resolves
 * with everything read back before the connection closes. Used for the
 * malformed-request-target test below (which needs a request-target
 * `fetch()` can never be made to send — fetch always sends origin-form
 * targets), and for the forged-`Host`/foreign-`Origin` tests (which need
 * a `Host` header `fetch()` can never be made to lie about — `fetch()`
 * always derives `Host` from the URL it's given, even when a `Host`
 * header is explicitly passed in `headers`). */
function sendRawRequest(port: number, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(raw);
    });
    let data = '';
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error('raw socket request timed out'));
    });
  });
}

const PROFILES: BoardProfile[] = [{ name: 'p1', connector: 'sqlite', hasDb: true }];
const TEST_VERSION = '0.0.0-test';

const FAKE_DAEMON_STATUS: DaemonStatus = {
  state: 'stopped',
  pid: null,
  startedAt: null,
  lastTickAt: null,
  inFlight: null,
  profiles: [],
};

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function recordingLogger(): Logger & { calls: Array<{ msg: string; data?: LogData }> } {
  const calls: Array<{ msg: string; data?: LogData }> = [];
  return {
    calls,
    debug(msg, data) {
      calls.push({ msg, data });
    },
    info(msg, data) {
      calls.push({ msg, data });
    },
    warn(msg, data) {
      calls.push({ msg, data });
    },
    error(msg, data) {
      calls.push({ msg, data });
    },
  };
}

function fakeStore(overrides: Partial<BoardStore> = {}): BoardStore & {
  patchCalls: Array<{ id: string; patch: TrackingPatch }>;
} {
  const patchCalls: Array<{ id: string; patch: TrackingPatch }> = [];
  return {
    patchCalls,
    listJobs(): { rows: []; total: number } {
      return { rows: [], total: 0 };
    },
    getJob() {
      return null;
    },
    updateTracking(id, patch) {
      patchCalls.push({ id, patch });
      return { jobId: id, updatedAt: '2026-08-02T00:00:00.000Z', status: 'Applied' };
    },
    listRuns() {
      return { rows: [], total: 0 };
    },
    getRun() {
      return null;
    },
    listRunEvents() {
      return { rows: [], total: 0 };
    },
    close() {},
    ...overrides,
  };
}

const SAMPLE_INTENT: RunIntent = {
  id: 7,
  requestedAt: '2026-08-07T09:00:00.000Z',
  status: 'pending',
  claimedRunId: null,
};

/** Records `cancel`'s numeric id argument so a socket test can prove
 * end-to-end DELETE param binding, not just that SOME 200 came back. */
function fakeIntentStore(): RunIntentStore & { cancelCalls: number[] } {
  const cancelCalls: number[] = [];
  return {
    cancelCalls,
    request: () => ({ intent: SAMPLE_INTENT, deduped: false }),
    cancel(id) {
      cancelCalls.push(id);
      return { outcome: 'cancelled', intent: { ...SAMPLE_INTENT, status: 'cancelled' } };
    },
    latest: () => SAMPLE_INTENT,
    list: () => [SAMPLE_INTENT],
    listClaimable: () => [],
    claim: () => true,
    attachRun: () => {},
    close() {},
  };
}

function fakeSource(
  opts: {
    store?: BoardStore | null;
    closed?: { value: boolean };
    intents?: RunIntentStore | null;
    runDoctor?: BoardSource['runDoctor'];
    readDaemonStatus?: BoardSource['readDaemonStatus'];
    removeProfile?: BoardSource['removeProfile'];
  } = {},
): BoardSource {
  const {
    store = null,
    closed,
    intents = null,
    runDoctor = async () => null,
    readDaemonStatus = async () => FAKE_DAEMON_STATUS,
    removeProfile = async () => ({ outcome: 'removed' }),
  } = opts;
  return {
    listProfiles: async () => PROFILES,
    openStore: async () => store,
    readConfigDoc: async () => undefined,
    writeConfigDoc: async () => {},
    createProfile: async () => {},
    openIntents: async () => intents,
    listSecrets: async () => ({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' }),
    writeSecret: async () => {},
    removeProfile,
    runDoctor,
    readDaemonStatus,
    close() {
      if (closed) closed.value = true;
    },
  };
}

async function withServer(
  server: ReturnType<typeof createBoardServer>,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const { port } = await server.listen(0);
  try {
    await fn(port);
  } finally {
    await server.close();
  }
}

test('GET /api/profiles returns the source data', async () => {
  const server = createBoardServer({
    source: fakeSource(),
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      profiles: [{ name: 'p1', connector: 'sqlite', hasDb: true }],
    });
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  });
});

test('DELETE /api/profiles/:name removes the profile', async () => {
  const server = createBoardServer({
    source: fakeSource({ removeProfile: async () => ({ outcome: 'removed' }) }),
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles/p1`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { removed: true, name: 'p1' });
  });
});

test('GET /api/profiles/:name/runs reaches the fake store (runs routes are mounted)', async () => {
  const store = fakeStore({
    listRuns() {
      return {
        rows: [
          {
            id: 1,
            date: '2026-08-05',
            timeDir: '09-00',
            kind: 'run',
            resumedFrom: null,
            status: 'passed',
            startedAt: '2026-08-05T09:00:00.000Z',
            finishedAt: '2026-08-05T09:05:00.000Z',
            heartbeatAt: '2026-08-05T09:04:00.000Z',
          },
        ],
        total: 1,
      };
    },
  });
  const server = createBoardServer({
    source: fakeSource({ store }),
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles/p1/runs`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: unknown[]; total: number };
    assert.equal(body.total, 1);
    assert.equal(body.rows.length, 1);
  });
});

test('GET /api/profiles/:name/doctor returns the report', async () => {
  const report = {
    findings: [{ check: 'home', status: 'ok' as const, detail: '/tmp/home' }],
    status: 'ok' as const,
  };
  const server = createBoardServer({
    source: fakeSource({ runDoctor: async () => report }),
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles/p1/doctor`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', findings: report.findings });
  });
});

test('POST /api/profiles/:name/run-intents queues one intent', async () => {
  const intents = fakeIntentStore();
  const server = createBoardServer({
    source: fakeSource({ intents }),
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles/p1/run-intents`, {
      method: 'POST',
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { intent: SAMPLE_INTENT, deduped: false });
  });
});

test('DELETE /api/profiles/:name/run-intents/:id cancels it', async () => {
  const intents = fakeIntentStore();
  const server = createBoardServer({
    source: fakeSource({ intents }),
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles/p1/run-intents/7`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(intents.cancelCalls, [7]);
  });
});

test('GET /api/profiles/:name/run-intents lists queued intents', async () => {
  const intents = fakeIntentStore();
  const server = createBoardServer({
    source: fakeSource({ intents }),
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles/p1/run-intents`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: RunIntent[] };
    assert.deepEqual(body.rows, [SAMPLE_INTENT]);
  });
});

test('unknown /api route is a 404 not_found envelope', async () => {
  const server = createBoardServer({
    source: fakeSource(),
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/nope`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'not_found');
  });
});

test('PATCH with a body reaches the fake store parsed', async () => {
  const store = fakeStore();
  const server = createBoardServer({
    source: fakeSource({ store }),
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/profiles/p1/jobs/li-1/tracking`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'Applied' }),
      },
    );
    assert.equal(res.status, 200);
    assert.equal(store.patchCalls.length, 1);
    assert.deepEqual(store.patchCalls[0], { id: 'li-1', patch: { status: 'Applied' } });
  });
});

test('PUT config doc reaches source.writeConfigDoc and echoes { text } back', async () => {
  const writeCalls: Array<{ name: string; doc: string; rawText: string }> = [];
  const source: BoardSource = {
    listProfiles: async () => PROFILES,
    openStore: async () => null,
    readConfigDoc: async () => undefined,
    writeConfigDoc: async (name, doc, rawText) => {
      writeCalls.push({ name, doc, rawText });
    },
    createProfile: async () => {},
    openIntents: async () => null,
    listSecrets: async () => ({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' }),
    writeSecret: async () => {},
    removeProfile: async () => ({ outcome: 'removed' }),
    runDoctor: async () => null,
    readDaemonStatus: async () => FAKE_DAEMON_STATUS,
    close() {},
  };
  const server = createBoardServer({
    source,
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/profiles/p1/config/filter.json`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '{"locations":[]}' }),
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { text: string };
    assert.deepEqual(body, { text: '{"locations":[]}' });
    assert.deepEqual(writeCalls, [
      { name: 'p1', doc: 'filter.json', rawText: '{"locations":[]}' },
    ]);
  });
});

test('POST /api/profiles reaches source.createProfile and returns 201', async () => {
  const createCalls: string[] = [];
  const source: BoardSource = {
    listProfiles: async () => PROFILES,
    openStore: async () => null,
    readConfigDoc: async () => undefined,
    writeConfigDoc: async () => {},
    createProfile: async (name) => {
      createCalls.push(name);
    },
    openIntents: async () => null,
    listSecrets: async () => ({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' }),
    writeSecret: async () => {},
    removeProfile: async () => ({ outcome: 'removed' }),
    runDoctor: async () => null,
    readDaemonStatus: async () => FAKE_DAEMON_STATUS,
    close() {},
  };
  const server = createBoardServer({
    source,
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'newprofile' }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { profile: BoardProfile };
    assert.deepEqual(body.profile, {
      name: 'newprofile',
      connector: 'sqlite',
      hasDb: true,
    });
    assert.deepEqual(createCalls, ['newprofile']);
  });
});

test('a throwing store method is a 500 internal envelope whose message is NOT the thrown one', async () => {
  const thrownMessage = '/very/secret/path/to/jobbunny.db is corrupt';
  const store = fakeStore({
    listJobs(): { rows: []; total: number } {
      throw new Error(thrownMessage);
    },
  });
  const logger = recordingLogger();
  const server = createBoardServer({
    source: fakeSource({ store }),
    logger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles/p1/jobs`);
    assert.equal(res.status, 500);
    const rawBody = await res.text();
    assert.ok(
      !rawBody.includes(thrownMessage),
      'thrown message must not leak into the body',
    );
    const body = JSON.parse(rawBody) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'internal');
    assert.ok(!body.error.message.includes(thrownMessage));
    // the real cause DID reach the logger, just not the HTTP response
    const errorLog = logger.calls.find((c) => c.msg === 'board: handler failed');
    assert.ok(errorLog);
    assert.ok(String(errorLog?.data?.error).includes(thrownMessage));
  });
});

test('a throwing source.openStore is also a 500 internal envelope (never a crash)', async () => {
  const source: BoardSource = {
    listProfiles: async () => PROFILES,
    openStore: async () => {
      throw new Error('db schema is newer than this build supports');
    },
    readConfigDoc: async () => undefined,
    writeConfigDoc: async () => {},
    createProfile: async () => {},
    openIntents: async () => null,
    listSecrets: async () => ({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' }),
    writeSecret: async () => {},
    removeProfile: async () => ({ outcome: 'removed' }),
    runDoctor: async () => null,
    readDaemonStatus: async () => FAKE_DAEMON_STATUS,
    close() {},
  };
  const server = createBoardServer({
    source,
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles/p1/jobs`);
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'internal');
  });
});

test('GET / with no uiDir serves the no-UI text page', async () => {
  const server = createBoardServer({
    source: fakeSource(),
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    const body = await res.text();
    assert.match(body, /npm run ui:build/);
  });
});

test('close() calls source.close()', async () => {
  const closed = { value: false };
  const server = createBoardServer({
    source: fakeSource({ closed }),
    logger: silentLogger,
    version: TEST_VERSION,
  });
  const { port } = await server.listen(0);
  assert.equal(closed.value, false);
  await server.close();
  assert.equal(closed.value, true);
  void port;
});

test('one http log line is emitted per request, including error responses', async () => {
  const logger = recordingLogger();
  const server = createBoardServer({
    source: fakeSource(),
    logger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    await fetch(`http://127.0.0.1:${port}/api/profiles`);
    await fetch(`http://127.0.0.1:${port}/api/nope`);
  });
  const httpLogs = logger.calls.filter((c) => c.msg === 'http');
  assert.equal(httpLogs.length, 2);
  assert.equal(httpLogs[0]?.data?.status, 200);
  assert.equal(httpLogs[1]?.data?.status, 404);
  assert.equal(typeof httpLogs[0]?.data?.ms, 'number');
});

// --- Hostile/edge request handling: malformed targets, zod leaks, double close ---

test('a malformed absolute-form request target is a 400 bad_request envelope, not a crash', async () => {
  // `fetch()` can only ever send an origin-form request-target, so this
  // reaches the handler's URL-parsing failure path via a raw socket. On
  // Node 24, `GET http://[::bad HTTP/1.1 ...` passes the HTTP parser (it
  // never rejects the request line) and lands in the handler as
  // `req.url === 'http://[::bad'`, which throws inside `new URL()`.
  const logger = recordingLogger();
  const server = createBoardServer({
    source: fakeSource(),
    logger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const raw = 'GET http://[::bad HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n';
    const response = await sendRawRequest(port, raw);
    assert.match(
      response,
      /^HTTP\/1\.1 400/,
      `expected a 400 status line, got: ${response}`,
    );
    assert.match(response, /"code":"bad_request"/);

    // The process (and this server instance) must still be alive: a
    // normal request right after must still succeed.
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles`);
    assert.equal(res.status, 200);
  });
});

// --- fix round: DNS-rebinding / cross-origin request forgery ---

test('a forged Host header is a 403 forbidden envelope, even for a plain GET', async () => {
  // A `Host` naming a different port (or a resolvable-but-attacker-owned
  // name, in a DNS-rebinding attack) must be rejected regardless of the
  // request-target — this is the check that survives DNS rebinding,
  // where the browser genuinely believes the request is same-origin so
  // no `Origin` header applies at all.
  const server = createBoardServer({
    source: fakeSource(),
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const raw = `GET /api/profiles HTTP/1.1\r\nHost: evil.example.com:${port}\r\nConnection: close\r\n\r\n`;
    const response = await sendRawRequest(port, raw);
    assert.match(
      response,
      /^HTTP\/1\.1 403/,
      `expected a 403 status line, got: ${response}`,
    );
    assert.match(response, /"code":"forbidden"/);
  });
});

test('a foreign Origin header is a 403 forbidden envelope even with a correct Host', async () => {
  // A CORS "simple request" (no body, no custom header — exactly what
  // `POST /api/profiles/:name/run-intents` is) still carries `Host`
  // correctly since the browser sends it to the real target; only
  // `Origin` betrays the cross-site page. Must be rejected even though
  // `Host` is legitimate.
  const server = createBoardServer({
    source: fakeSource(),
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const raw = `GET /api/profiles HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://evil.example.com\r\nConnection: close\r\n\r\n`;
    const response = await sendRawRequest(port, raw);
    assert.match(
      response,
      /^HTTP\/1\.1 403/,
      `expected a 403 status line, got: ${response}`,
    );
    assert.match(response, /"code":"forbidden"/);
  });
});

test('a real ZodError leaking from a route handler is converted to 400 validation (belt-and-braces)', async () => {
  // `routes.ts`'s own `parseOrThrow` never lets a ZodError escape (it
  // uses `safeParse` and converts to `HttpError` itself); this simulates
  // one leaking from deeper in the call stack — e.g. a store method that
  // throws a raw ZodError instead of an HttpError.
  let realZodError: unknown;
  try {
    z.string().parse(123);
  } catch (err) {
    realZodError = err;
  }
  assert.ok(realZodError instanceof z.ZodError, 'setup: must be a genuine ZodError');

  const store = fakeStore({
    updateTracking(): never {
      throw realZodError as Error;
    },
  });
  const server = createBoardServer({
    source: fakeSource({ store }),
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/profiles/p1/jobs/li-1/tracking`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'Applied' }),
      },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'validation');
  });
});

test('PUT then GET /api/secrets round-trips presence without echoing the value', async () => {
  const written = new Map<string, string>();
  const source: BoardSource = {
    listProfiles: async () => PROFILES,
    openStore: async () => null,
    readConfigDoc: async () => undefined,
    writeConfigDoc: async () => {},
    createProfile: async () => {},
    openIntents: async () => null,
    listSecrets: async () => ({
      NOTION_TOKEN: written.has('NOTION_TOKEN') ? 'present' : 'absent',
      TELEGRAM_BOT_TOKEN: written.has('TELEGRAM_BOT_TOKEN') ? 'present' : 'absent',
    }),
    writeSecret: async (key, value) => {
      written.set(key, value);
    },
    removeProfile: async () => ({ outcome: 'removed' }),
    runDoctor: async () => null,
    readDaemonStatus: async () => FAKE_DAEMON_STATUS,
    close() {},
  };
  const server = createBoardServer({
    source,
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const putRes = await fetch(`http://127.0.0.1:${port}/api/secrets/NOTION_TOKEN`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'tok-123-secret' }),
    });
    assert.equal(putRes.status, 200);
    const putText = await putRes.text();
    assert.ok(!putText.includes('tok-123-secret'));
    assert.deepEqual(JSON.parse(putText), { key: 'NOTION_TOKEN', status: 'present' });

    const getRes = await fetch(`http://127.0.0.1:${port}/api/secrets`);
    assert.equal(getRes.status, 200);
    const body = (await getRes.json()) as Record<string, string>;
    assert.equal(body.NOTION_TOKEN, 'present');
    assert.equal(body.TELEGRAM_BOT_TOKEN, 'absent');
  });
});

test('close() still calls source.close() when httpServer.close() rejects', async () => {
  const closed = { value: false };
  let closeCallCount = 0;
  const source: BoardSource = {
    listProfiles: async () => PROFILES,
    openStore: async () => null,
    readConfigDoc: async () => undefined,
    writeConfigDoc: async () => {},
    createProfile: async () => {},
    openIntents: async () => null,
    listSecrets: async () => ({ NOTION_TOKEN: 'absent', TELEGRAM_BOT_TOKEN: 'absent' }),
    writeSecret: async () => {},
    removeProfile: async () => ({ outcome: 'removed' }),
    runDoctor: async () => null,
    readDaemonStatus: async () => FAKE_DAEMON_STATUS,
    close() {
      closeCallCount += 1;
      closed.value = true;
    },
  };
  const server = createBoardServer({
    source,
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await server.listen(0);

  await server.close();
  assert.equal(closed.value, true);
  assert.equal(closeCallCount, 1);

  // Second close(): the underlying httpServer is already closed, so
  // `httpServer.close()` rejects (ERR_SERVER_NOT_RUNNING) — but
  // `source.close()` must still run, per the `close() { ... also calls
  // source.close() }` contract.
  await assert.rejects(() => server.close());
  assert.equal(
    closeCallCount,
    2,
    'source.close() must run even when httpServer.close() rejects',
  );
});

test('GET /api/personas serves the catalog over HTTP', async () => {
  const server = createBoardServer({
    source: fakeSource(),
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/personas`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = (await res.json()) as typeof PERSONA_CATALOG;
    assert.equal(body.personas.length, 11);
    assert.equal(body.personas[body.personas.length - 1]?.id, 'scratch');
  });
});

test('GET /api/daemon reports the daemon state', async () => {
  const status: DaemonStatus = {
    state: 'running',
    pid: 4242,
    startedAt: '2026-08-07T00:00:00.000Z',
    lastTickAt: '2026-08-07T09:59:30.000Z',
    inFlight: null,
    profiles: [
      { profile: 'rajni', enabled: true, nextRunAt: '2026-08-08T03:30:00.000Z' },
    ],
  };
  const server = createBoardServer({
    source: fakeSource({ readDaemonStatus: async () => status }),
    logger: silentLogger,
    version: TEST_VERSION,
  });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/daemon`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as DaemonStatus;
    assert.equal(body.state, 'running');
  });
});
