import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Logger, RunContext } from '../../../ports/context.ts';
import type { ChromeProcessHandle, KillDeps, LauncherDeps } from './launcher.ts';
import { DEFAULT_USER_DATA_DIR } from './launcher.ts';
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

test('launch() spawns Chrome via the injected launcher and connects to http://127.0.0.1:<port>', async () => {
  const launcher = fakeLauncher(4242);
  const connectUrls: string[] = [];
  const provider = new CdpChromeProvider({
    port: 9333,
    launchChrome: launcher.launchChrome,
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
  assert.deepEqual(killCalls[0]?.deps, { env: {} });
});

test('close() respects JOBBUNNY_KEEP_BROWSER=1 by delegating the decision to killChrome', async () => {
  const killCalls: number[] = [];
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher(4242).launchChrome,
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

test('name is "cdp-chrome"', () => {
  const provider = new CdpChromeProvider({
    launchChrome: fakeLauncher().launchChrome,
    connect: async () => ({ newPage: async () => fakePage() }) satisfies CdpBrowser,
  });
  assert.equal(provider.name, 'cdp-chrome');
});
