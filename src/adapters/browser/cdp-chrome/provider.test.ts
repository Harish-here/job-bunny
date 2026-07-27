import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Logger, RunContext } from '../../../ports/context.ts';
import type { ChromeProcessHandle, KillDeps, LauncherDeps } from './launcher.ts';
import { DEFAULT_USER_DATA_DIR } from './launcher.ts';
import type { ChromePidfileDeps } from './ownership/index.ts';
import type { CdpBrowser, CdpPage } from './provider.ts';
import { CdpChromeProvider } from './provider.ts';

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function fakeCtx(signal: AbortSignal = new AbortController().signal): RunContext {
  return { profile: 'rajni', signal, logger: noopLogger, beat() {} };
}

/** A logger that records every error() call so tests can assert the
 * underlying connect failure actually reached the log, not just the
 * thrown Error's `cause`. */
function capturingErrorLogger(): { logger: Logger; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error(msg, data) {
        calls.push([msg, data]);
      },
    },
  };
}

/** A fake page whose method behavior is fully controlled per-test — either
 * resolves immediately with a value, or hangs forever (never settles) to
 * exercise the deadline race. */
function fakePage(overrides: Partial<CdpPage> = {}): CdpPage {
  return {
    goto: async () => undefined,
    evaluate: async () => undefined as never,
    click: async () => undefined,
    waitForSelector: async () => undefined,
    content: async () => '',
    close: async () => undefined,
    ...overrides,
  };
}

function hang<T>(): () => Promise<T> {
  return () => new Promise<T>(() => {});
}

/** hang(), specialized for CdpPage.evaluate's generic signature. */
const hangEvaluate: CdpPage['evaluate'] = () => new Promise(() => {});

function fakeLauncher(pid = 4242): {
  calls: Array<{ options: unknown; deps: unknown }>;
  launchChrome: (
    options: { port: number; userDataDir?: string; candidates?: readonly string[] },
    deps?: LauncherDeps,
  ) => ChromeProcessHandle;
} {
  const calls: Array<{ options: unknown; deps: unknown }> = [];
  return {
    calls,
    launchChrome: (options, deps) => {
      calls.push({ options, deps });
      return { pid };
    },
  };
}

/** Builds a ChromePidfileDeps fake. `exists: false` (or omitting `pid`)
 * models "no live pid file" (the reachable-but-unowned case); otherwise
 * `pid`/`ageMs` model a live pid file recorded `ageMs` ago relative to a
 * fixed `now`.
 *
 * The anchor can be a hardcoded date because launch() ages startedAt with
 * `pidfileDeps.now()` — this same injected clock — never the real one, so
 * `ageMs` means exactly what it says regardless of when the suite runs. */
function fakePidfileDeps(
  overrides: { pid?: number; ageMs?: number; exists?: boolean } = {},
): ChromePidfileDeps {
  const exists = overrides.exists ?? overrides.pid !== undefined;
  const pid = overrides.pid ?? 0;
  const ageMs = overrides.ageMs ?? 0;
  const now = new Date('2026-07-27T12:00:00.000Z');
  const startedAt = new Date(now.getTime() - ageMs).toISOString();
  return {
    existsSync: () => exists,
    readFileSync: () => JSON.stringify({ pid, port: 9222, startedAt }),
    writeFileSync: () => {},
    mkdirSync: () => {},
    unlinkSync: () => {},
    pidIsAlive: () => true,
    now: () => now,
  };
}

test('launch() spawns Chrome via the injected launcher and connects to http://127.0.0.1:<port>', async () => {
  const launcher = fakeLauncher(4242);
  const connectUrls: string[] = [];
  const provider = new CdpChromeProvider({
    port: 9333,
    launchChrome: launcher.launchChrome,
    cdpReachable: async () => null,
    connect: async (url) => {
      connectUrls.push(url);
      return { newPage: async () => fakePage() } satisfies CdpBrowser;
    },
  });

  const handle = await provider.launch(fakeCtx());

  assert.equal(handle.cdpUrl, 'http://127.0.0.1:9333');
  assert.deepEqual(connectUrls, ['http://127.0.0.1:9333']);
  assert.equal(launcher.calls.length, 1);
  assert.deepEqual(launcher.calls[0]?.options, {
    port: 9333,
    userDataDir: DEFAULT_USER_DATA_DIR,
    candidates: undefined,
  } as never);
});

test('newPage() wraps the connected browser page in a PageHandle that passes calls through', async () => {
  const goneUrls: string[] = [];
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    connect: async () =>
      ({
        newPage: async () =>
          fakePage({
            goto: async (url) => {
              goneUrls.push(url);
              return undefined;
            },
          }),
      }) satisfies CdpBrowser,
  });

  const handle = await provider.launch(fakeCtx());
  const page = await handle.newPage();
  await page.goto('https://example.com', { timeoutMs: 1000 });

  assert.deepEqual(goneUrls, ['https://example.com']);
});

test('close() kills the spawned Chrome pid by default (JOBBUNNY_KEEP_BROWSER unset)', async () => {
  const killCalls: Array<{ pid: number | undefined; deps: KillDeps | undefined }> = [];
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher(4242).launchChrome,
    cdpReachable: async () => null,
    connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
    killChrome: (pid, deps) => {
      killCalls.push({ pid, deps });
      return true;
    },
    killEnv: {},
  });

  const handle = await provider.launch(fakeCtx());
  await handle.close();

  assert.equal(killCalls.length, 1);
  assert.equal(killCalls[0]?.pid, 4242);
  assert.deepEqual(killCalls[0]?.deps?.env, {});
  // The pid file this kill must clear is identified by userDataDir, and the
  // deps used to clear it must be the provider's injected ones — otherwise
  // killChrome silently falls back to the real .chrome-debug/ + real fs.
  assert.equal(killCalls[0]?.deps?.userDataDir, DEFAULT_USER_DATA_DIR);
  assert.ok(killCalls[0]?.deps?.pidfileDeps);
});

test('close() respects JOBBUNNY_KEEP_BROWSER=1 by delegating the decision to killChrome', async () => {
  const killCalls: number[] = [];
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher(4242).launchChrome,
    cdpReachable: async () => null,
    connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
    killEnv: { JOBBUNNY_KEEP_BROWSER: '1' },
    // real killChrome honors JOBBUNNY_KEEP_BROWSER itself — assert it's the
    // one making the call, with the env threaded through, not that the
    // provider special-cases it.
    killChrome: (pid, deps) => {
      if (deps?.env?.JOBBUNNY_KEEP_BROWSER === '1') return false;
      killCalls.push(pid ?? -1);
      return true;
    },
  });

  const handle = await provider.launch(fakeCtx());
  await handle.close();

  assert.deepEqual(killCalls, []);
});

test('close() never calls a browser.close()-style API — only the OS-level pid kill', async () => {
  // CdpBrowser intentionally has no close() method in its type, but this
  // guards against a future accidental addition being invoked.
  let closeAttempted = false;
  const browser: CdpBrowser & { close?: () => Promise<void> } = {
    newPage: async () => fakePage(),
    close: async () => {
      closeAttempted = true;
    },
  };
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    connect: async () => browser,
    killChrome: () => true,
  });

  const handle = await provider.launch(fakeCtx());
  await handle.close();

  assert.equal(closeAttempted, false);
});

test('PageHandle.evaluate rejects at ~timeoutMs when the underlying playwright call hangs forever', async () => {
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    connect: async () =>
      ({
        newPage: async () => fakePage({ evaluate: hangEvaluate }),
      }) satisfies CdpBrowser,
  });
  const handle = await provider.launch(fakeCtx());
  const page = await handle.newPage();

  const start = Date.now();
  await assert.rejects(() => page.evaluate('1 + 1', { timeoutMs: 40 }), /timed out/);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `expected rejection near 40ms, took ${elapsed}ms`);
});

test('PageHandle.goto passes through a resolving playwright call without waiting for the deadline', async () => {
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
  });
  const handle = await provider.launch(fakeCtx());
  const page = await handle.newPage();

  const start = Date.now();
  await page.goto('https://example.com', { timeoutMs: 5000 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 200, `expected near-instant pass-through, took ${elapsed}ms`);
});

test('PageHandle.click rejects at ~timeoutMs when the underlying playwright call hangs forever', async () => {
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    connect: async () =>
      ({ newPage: async () => fakePage({ click: hang() }) }) satisfies CdpBrowser,
  });
  const handle = await provider.launch(fakeCtx());
  const page = await handle.newPage();

  await assert.rejects(
    () => page.click('.job-card', { timeoutMs: 30 }),
    /click\(\.job-card\) timed out/,
  );
});

test('PageHandle.waitFor rejects at ~timeoutMs when the underlying playwright call hangs forever', async () => {
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    connect: async () =>
      ({
        newPage: async () => fakePage({ waitForSelector: hang() }),
      }) satisfies CdpBrowser,
  });
  const handle = await provider.launch(fakeCtx());
  const page = await handle.newPage();

  await assert.rejects(
    () => page.waitFor('#job-details', { timeoutMs: 30 }),
    /timed out/,
  );
});

test('PageHandle.content rejects at ~timeoutMs when the underlying playwright call hangs forever', async () => {
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    connect: async () =>
      ({ newPage: async () => fakePage({ content: hang() }) }) satisfies CdpBrowser,
  });
  const handle = await provider.launch(fakeCtx());
  const page = await handle.newPage();

  await assert.rejects(() => page.content({ timeoutMs: 30 }), /timed out/);
});

test('PageHandle deadline also fires when ctx.signal aborts before opts.timeoutMs', async () => {
  const controller = new AbortController();
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    connect: async () =>
      ({
        newPage: async () => fakePage({ evaluate: hangEvaluate }),
      }) satisfies CdpBrowser,
  });
  const handle = await provider.launch(fakeCtx(controller.signal));
  const page = await handle.newPage();

  const pending = assert.rejects(
    () => page.evaluate('1', { timeoutMs: 60_000 }),
    /timed out/,
  );
  controller.abort(new Error('run cancelled'));
  await pending;
});

test('PageHandle.close() closes the underlying playwright page directly (no deadline race)', async () => {
  let closed = false;
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    connect: async () =>
      ({
        newPage: async () =>
          fakePage({
            close: async () => {
              closed = true;
            },
          }),
      }) satisfies CdpBrowser,
  });
  const handle = await provider.launch(fakeCtx());
  const page = await handle.newPage();
  await page.close();

  assert.equal(closed, true);
});

test('launch() retries connect on failure and resolves once it succeeds', async () => {
  let attempts = 0;
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    connectRetryMs: 1,
    connectMaxWaitMs: 1000,
    connect: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`connect refused (attempt ${attempts})`);
      return { newPage: async () => fakePage() } satisfies CdpBrowser;
    },
  });

  const handle = await provider.launch(fakeCtx());

  assert.equal(attempts, 3);
  assert.equal(handle.cdpUrl, 'http://127.0.0.1:9222');
});

test('launch() connects on the first try with no retry when connect succeeds immediately', async () => {
  let attempts = 0;
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    connectRetryMs: 1,
    connectMaxWaitMs: 1000,
    connect: async () => {
      attempts += 1;
      return { newPage: async () => fakePage() } satisfies CdpBrowser;
    },
  });

  await provider.launch(fakeCtx());

  assert.equal(attempts, 1);
});

test('launch() rejects after connectMaxWaitMs when connect always fails, naming the cdpUrl and the last error as cause', async () => {
  let attempts = 0;
  const lastError = new Error('ECONNREFUSED');
  const provider = new CdpChromeProvider({
    port: 9222,
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    // The give-up path kills the spawned pid. Both deps are faked so this
    // test never signals a real process (pid 4242 may belong to something
    // live, which would stall the timing assertion below) and never
    // touches the real .chrome-debug/ pid file.
    pidfileDeps: fakePidfileDeps(),
    killChrome: () => true,
    connectRetryMs: 1,
    connectMaxWaitMs: 20,
    connect: async () => {
      attempts += 1;
      throw lastError;
    },
  });

  const start = Date.now();
  await assert.rejects(
    () => provider.launch(fakeCtx()),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /http:\/\/127\.0\.0\.1:9222/);
      assert.equal(err.cause, lastError);
      return true;
    },
  );
  const elapsed = Date.now() - start;

  assert.ok(attempts > 1, `expected more than one connect attempt, got ${attempts}`);
  // The original tight bound (~20ms) was flaky under load (observed ~800ms on a loaded machine).
  // 2000ms still fails if a real multi-second wait or retry backoff is introduced, which is the property under test.
  assert.ok(elapsed < 2000, `expected rejection near the 20ms cap, took ${elapsed}ms`);
});

test('launch() logs the underlying connect error (message + cause) before giving up', async () => {
  const underlying = new Error('browserType.connectOverCDP: Timeout 30000ms exceeded.');
  const { logger, calls } = capturingErrorLogger();
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    // Faked so the give-up kill neither signals a real pid 4242 nor
    // touches the real .chrome-debug/ pid file.
    pidfileDeps: fakePidfileDeps(),
    killChrome: () => true,
    connectRetryMs: 1,
    connectMaxWaitMs: 20,
    connect: async () => {
      throw underlying;
    },
  });

  await assert.rejects(
    () =>
      provider.launch({
        profile: 'rajni',
        signal: new AbortController().signal,
        logger,
        beat() {},
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.cause, underlying);
      return true;
    },
  );

  const errorCall = calls.find(([msg]) => msg.includes('gave up connecting'));
  assert.ok(errorCall, 'expected an error() log call about giving up');
  const [, data] = errorCall as [string, Record<string, unknown>];
  assert.equal(data.error, underlying.message);
});

// Defect: a single connect() attempt that hangs past playwright's own
// internal timeout (observed: ~30s) must not be allowed to outlive
// connectMaxWaitMs. Each attempt is raced against the remaining budget so
// the configured cap bounds real wall-clock time, not just the
// retry-after-the-fact decision.
test('launch() enforces connectMaxWaitMs even when a single connect() attempt hangs past it', async () => {
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    // Faked so the give-up kill neither signals a real pid 4242 nor
    // touches the real .chrome-debug/ pid file.
    pidfileDeps: fakePidfileDeps(),
    killChrome: () => true,
    connectRetryMs: 1,
    connectMaxWaitMs: 50,
    // Simulates playwright's connectOverCDP internal timeout (~30s in the
    // real incident) — never resolves or rejects within the test's
    // lifetime on its own.
    connect: () => new Promise<CdpBrowser>(() => {}),
  });

  const start = Date.now();
  await assert.rejects(
    () => provider.launch(fakeCtx()),
    /gave up connecting to Chrome CDP/,
  );
  const elapsed = Date.now() - start;

  // Bounded well below the ~30s a real unraced hang would take — proves the
  // per-attempt race, not just the outer retry loop, enforces the cap.
  assert.ok(elapsed < 2000, `expected rejection near the 50ms cap, took ${elapsed}ms`);
});

test('launch() kills the spawned Chrome pid when connect gives up (no leak)', async () => {
  const killCalls: Array<{ pid: number | undefined; deps: KillDeps | undefined }> = [];
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher(4242).launchChrome,
    cdpReachable: async () => null,
    connectRetryMs: 1,
    connectMaxWaitMs: 10,
    connect: async () => {
      throw new Error('connect refused');
    },
    killChrome: (pid, deps) => {
      killCalls.push({ pid, deps });
      return true;
    },
    killEnv: {},
  });

  await assert.rejects(() => provider.launch(fakeCtx()));

  assert.equal(killCalls.length, 1);
  assert.equal(killCalls[0]?.pid, 4242);
  assert.deepEqual(killCalls[0]?.deps?.env, {});
  assert.equal(killCalls[0]?.deps?.userDataDir, DEFAULT_USER_DATA_DIR);
  assert.ok(killCalls[0]?.deps?.pidfileDeps);
});

test('launch() stops retrying and rejects when ctx.signal aborts mid-retry', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    // Faked so the give-up kill neither signals a real pid 4242 nor
    // touches the real .chrome-debug/ pid file.
    pidfileDeps: fakePidfileDeps(),
    killChrome: () => true,
    connectRetryMs: 5,
    connectMaxWaitMs: 60_000,
    connect: async () => {
      attempts += 1;
      if (attempts === 1) controller.abort(new Error('run cancelled'));
      throw new Error('connect refused');
    },
  });

  const start = Date.now();
  await assert.rejects(() => provider.launch(fakeCtx(controller.signal)), /aborted/);
  const elapsed = Date.now() - start;

  assert.ok(
    elapsed < 500,
    `expected near-immediate rejection on abort, took ${elapsed}ms`,
  );
});

test('launch() reuses a reachable Chrome whose pid-file-recorded age is under maxAgeMs', async () => {
  const launcher = fakeLauncher(4242);
  const connectUrls: string[] = [];
  const provider = new CdpChromeProvider({
    launchChrome: launcher.launchChrome,
    cdpReachable: async () => ({ Browser: 'Chrome/999' }),
    pidfileDeps: fakePidfileDeps({ pid: 5555, ageMs: 60_000 }), // 1 minute old
    connect: async (url) => {
      connectUrls.push(url);
      return { newPage: async () => fakePage() } satisfies CdpBrowser;
    },
  });

  const handle = await provider.launch(fakeCtx());

  assert.equal(
    launcher.calls.length,
    0,
    'expected no spawn when Chrome is already reachable and fresh',
  );
  assert.deepEqual(connectUrls, ['http://127.0.0.1:9222']);
  assert.equal(handle.cdpUrl, 'http://127.0.0.1:9222');
});

test('launch() spawns Chrome when the port is not reachable, consulting no pid file', async () => {
  const launcher = fakeLauncher(4242);
  let pidfileReadAttempted = false;
  const provider = new CdpChromeProvider({
    launchChrome: launcher.launchChrome,
    cdpReachable: async () => null,
    pidfileDeps: {
      ...fakePidfileDeps(),
      existsSync: () => {
        pidfileReadAttempted = true;
        return false;
      },
    },
    connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
  });

  await provider.launch(fakeCtx());

  assert.equal(launcher.calls.length, 1, 'expected a spawn when nothing is reachable');
  assert.equal(
    pidfileReadAttempted,
    false,
    'expected the pid file never to be consulted when unreachable',
  );
});

test('launch() recycles a reachable Chrome whose pid-file-recorded age is over maxAgeMs', async () => {
  const launcher = fakeLauncher(7777);
  const killCalls: Array<number | undefined> = [];
  const provider = new CdpChromeProvider({
    launchChrome: launcher.launchChrome,
    cdpReachable: async () => ({ Browser: 'Chrome/999' }),
    pidfileDeps: fakePidfileDeps({ pid: 5555, ageMs: 25 * 60 * 60 * 1000 }), // 25h
    killChrome: (pid) => {
      killCalls.push(pid);
      return true;
    },
    connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
  });

  const handle = await provider.launch(fakeCtx());

  assert.deepEqual(killCalls, [5555]);
  assert.equal(launcher.calls.length, 1, 'expected a fresh spawn after recycling');
  assert.equal(handle.cdpUrl, 'http://127.0.0.1:9222');
});

test('launch() reuses a stale-pid-file Chrome without recycling when recycleIfOld is false', async () => {
  const launcher = fakeLauncher(7777);
  const killCalls: Array<number | undefined> = [];
  const provider = new CdpChromeProvider({
    launchChrome: launcher.launchChrome,
    cdpReachable: async () => ({ Browser: 'Chrome/999' }),
    pidfileDeps: fakePidfileDeps({ pid: 5555, ageMs: 25 * 60 * 60 * 1000 }),
    recycleIfOld: false,
    killChrome: (pid) => {
      killCalls.push(pid);
      return true;
    },
    connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
  });

  await provider.launch(fakeCtx());

  assert.deepEqual(killCalls, []);
  assert.equal(launcher.calls.length, 0, 'expected no spawn when recycling is disabled');
});

test('close() is a no-op for a reused Chrome — never kills a process this run did not spawn', async () => {
  // Regression test for the 2026-07-25 incident: reuse must not kill the
  // user's own persistent, already-logged-in Chrome on close().
  const launcher = fakeLauncher(7777);
  const killCalls: unknown[] = [];
  const provider = new CdpChromeProvider({
    launchChrome: launcher.launchChrome,
    cdpReachable: async () => ({ Browser: 'Chrome/999' }),
    pidfileDeps: fakePidfileDeps({ pid: 5555, ageMs: 60_000 }), // fresh
    killChrome: (pid) => {
      killCalls.push(pid);
      return true;
    },
    killEnv: {},
    connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
  });

  const handle = await provider.launch(fakeCtx());
  await handle.close();

  assert.equal(
    launcher.calls.length,
    0,
    'expected no spawn — Chrome was reachable and fresh',
  );
  assert.deepEqual(killCalls, [], 'expected close() not to kill a reused Chrome');
});

test('close() is a no-op for a stale-but-kept Chrome when recycleIfOld is false', async () => {
  const launcher = fakeLauncher(7777);
  const killCalls: unknown[] = [];
  const provider = new CdpChromeProvider({
    launchChrome: launcher.launchChrome,
    cdpReachable: async () => ({ Browser: 'Chrome/999' }),
    pidfileDeps: fakePidfileDeps({ pid: 5555, ageMs: 25 * 60 * 60 * 1000 }),
    recycleIfOld: false,
    killChrome: (pid) => {
      killCalls.push(pid);
      return true;
    },
    killEnv: {},
    connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
  });

  const handle = await provider.launch(fakeCtx());
  await handle.close();

  assert.deepEqual(
    killCalls,
    [],
    'expected close() not to kill a stale-but-kept Chrome (recycleIfOld: false)',
  );
});

test('close() kills a fresh spawn (action launch) — this run owns that process', async () => {
  const launcher = fakeLauncher(4242);
  const killCalls: unknown[] = [];
  const provider = new CdpChromeProvider({
    launchChrome: launcher.launchChrome,
    cdpReachable: async () => null, // unreachable -> action 'launch'
    killChrome: (pid) => {
      killCalls.push(pid);
      return true;
    },
    killEnv: {},
    connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
  });

  const handle = await provider.launch(fakeCtx());
  await handle.close();

  assert.deepEqual(
    killCalls,
    [4242],
    'expected close() to kill a Chrome this run spawned',
  );
});

test('close() respects JOBBUNNY_KEEP_BROWSER=1 after a recycle-then-spawn (owned process, global override)', async () => {
  const launcher = fakeLauncher(8888);
  const killCalls: unknown[] = [];
  const provider = new CdpChromeProvider({
    launchChrome: launcher.launchChrome,
    cdpReachable: async () => ({ Browser: 'Chrome/999' }),
    pidfileDeps: fakePidfileDeps({ pid: 5555, ageMs: 25 * 60 * 60 * 1000 }),
    killEnv: { JOBBUNNY_KEEP_BROWSER: '1' },
    killChrome: (pid, deps) => {
      if (deps?.env?.JOBBUNNY_KEEP_BROWSER === '1') return false;
      killCalls.push(pid);
      return true;
    },
    connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
  });

  const handle = await provider.launch(fakeCtx());
  await handle.close();

  assert.deepEqual(
    killCalls,
    [],
    'expected JOBBUNNY_KEEP_BROWSER=1 to suppress the kill even for an owned (recycled) process',
  );
});

test('name is "cdp-chrome"', () => {
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
  });
  assert.equal(provider.name, 'cdp-chrome');
});

// --- newPage() must use the persistent (logged-in) browser context ---
//
// Regression tests, 2026-07-25. playwright's `browser.newPage()` is shorthand
// for `newContext()` + `newPage()` — a FRESH, cookie-less context. Over
// connectOverCDP the logged-in profile lives in `browser.contexts()[0]`, so
// calling `browser.newPage()` opened every pipeline page logged OUT while the
// real Chrome profile was logged in. Observed as LinkedIn's logout wall on
// every url despite a valid li_at cookie. v0 never had this bug:
// scripts/lib/browser.js:180 does `browser.contexts()[0] || newContext()`.

test('newPage() opens the page in the existing persistent context, not a fresh one', async () => {
  let usedPersistentContext = false;
  let usedBrowserNewPage = false;
  const browser: CdpBrowser = {
    newPage: async () => {
      usedBrowserNewPage = true;
      return fakePage();
    },
    contexts: () => [
      {
        newPage: async () => {
          usedPersistentContext = true;
          return fakePage();
        },
      },
    ],
  };
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    connect: async () => browser,
    killChrome: () => true,
  });

  const handle = await provider.launch(fakeCtx());
  await handle.newPage();

  assert.equal(usedPersistentContext, true);
  assert.equal(usedBrowserNewPage, false);
});

test('newPage() falls back to newContext() when the browser reports no contexts', async () => {
  let createdContext = false;
  const browser: CdpBrowser = {
    newPage: async () => fakePage(),
    contexts: () => [],
    newContext: async () => {
      createdContext = true;
      return { newPage: async () => fakePage() };
    },
  };
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    cdpReachable: async () => null,
    connect: async () => browser,
    killChrome: () => true,
  });

  const handle = await provider.launch(fakeCtx());
  await handle.newPage();

  assert.equal(createdContext, true);
});

test('launch() attaches (reuse) to a reachable Chrome with no live pid file, and close() never kills it (ownsProcess === false)', async () => {
  const launcher = fakeLauncher(4242);
  const killCalls: unknown[] = [];
  const provider = new CdpChromeProvider({
    launchChrome: launcher.launchChrome,
    cdpReachable: async () => ({ Browser: 'Chrome/999' }),
    pidfileDeps: fakePidfileDeps({ exists: false }),
    killChrome: (pid) => {
      killCalls.push(pid);
      return true;
    },
    connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
  });

  const handle = await provider.launch(fakeCtx());
  await handle.close();

  assert.equal(
    launcher.calls.length,
    0,
    'expected no spawn — Chrome is already reachable',
  );
  assert.deepEqual(killCalls, [], 'expected close() never to kill an unowned Chrome');
});

test('close() kills the freshly-respawned Chrome pid after a recycle — this run owns the new process, not the old one', async () => {
  const launcher = fakeLauncher(8888);
  const killCalls: unknown[] = [];
  const provider = new CdpChromeProvider({
    launchChrome: launcher.launchChrome,
    cdpReachable: async () => ({ Browser: 'Chrome/999' }),
    pidfileDeps: fakePidfileDeps({ pid: 5555, ageMs: 25 * 60 * 60 * 1000 }), // stale -> recycle
    killChrome: (pid) => {
      killCalls.push(pid);
      return true;
    },
    connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
  });

  const handle = await provider.launch(fakeCtx());
  killCalls.length = 0; // clear the recycle-time kill (pre-spawn, pid 5555); isolate close()'s own kill
  await handle.close();

  assert.deepEqual(
    killCalls,
    [8888],
    'expected close() to kill the freshly-spawned pid this run owns, not the old listener pid',
  );
});
