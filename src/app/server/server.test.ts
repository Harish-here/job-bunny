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
import type {
  BoardProfile,
  BoardSource,
  BoardStore,
  TrackingPatch,
} from '../../ports/board.ts';
import type { LogData, Logger } from '../../ports/context.ts';
import { createBoardServer } from './server.ts';

/** Sends a raw request line/headers over a plain TCP socket and resolves
 * with everything read back before the connection closes. Used only for
 * the malformed-request-target test below, which needs a request-target
 * that `fetch()` can never be made to send (fetch always sends
 * origin-form targets). */
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
    close() {},
    ...overrides,
  };
}

function fakeSource(
  opts: { store?: BoardStore | null; closed?: { value: boolean } } = {},
): BoardSource {
  const { store = null, closed } = opts;
  return {
    listProfiles: () => PROFILES,
    openStore: () => store,
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
  const server = createBoardServer({ source: fakeSource(), logger: silentLogger });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      profiles: [{ name: 'p1', connector: 'sqlite', hasDb: true }],
    });
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  });
});

test('unknown /api route is a 404 not_found envelope', async () => {
  const server = createBoardServer({ source: fakeSource(), logger: silentLogger });
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

test('a throwing store method is a 500 internal envelope whose message is NOT the thrown one', async () => {
  const thrownMessage = '/very/secret/path/to/jobbunny.db is corrupt';
  const store = fakeStore({
    listJobs(): { rows: []; total: number } {
      throw new Error(thrownMessage);
    },
  });
  const logger = recordingLogger();
  const server = createBoardServer({ source: fakeSource({ store }), logger });
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
    listProfiles: () => PROFILES,
    openStore: () => {
      throw new Error('db schema is newer than this build supports');
    },
    close() {},
  };
  const server = createBoardServer({ source, logger: silentLogger });
  await withServer(server, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/profiles/p1/jobs`);
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'internal');
  });
});

test('GET / with no uiDir serves the no-UI text page', async () => {
  const server = createBoardServer({ source: fakeSource(), logger: silentLogger });
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
  });
  const { port } = await server.listen(0);
  assert.equal(closed.value, false);
  await server.close();
  assert.equal(closed.value, true);
  void port;
});

test('one http log line is emitted per request, including error responses', async () => {
  const logger = recordingLogger();
  const server = createBoardServer({ source: fakeSource(), logger });
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

// --- Review findings: fix round 1 ---------------------------------------

test('a malformed absolute-form request target is a 400 bad_request envelope, not a crash', async () => {
  // `fetch()` can only ever send an origin-form request-target, so this
  // reaches the handler's URL-parsing failure path via a raw socket. On
  // Node 24, `GET http://[::bad HTTP/1.1 ...` passes the HTTP parser (it
  // never rejects the request line) and lands in the handler as
  // `req.url === 'http://[::bad'`, which throws inside `new URL()`.
  const logger = recordingLogger();
  const server = createBoardServer({ source: fakeSource(), logger });
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

test('close() still calls source.close() when httpServer.close() rejects', async () => {
  const closed = { value: false };
  let closeCallCount = 0;
  const source: BoardSource = {
    listProfiles: () => PROFILES,
    openStore: () => null,
    close() {
      closeCallCount += 1;
      closed.value = true;
    },
  };
  const server = createBoardServer({ source, logger: silentLogger });
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
