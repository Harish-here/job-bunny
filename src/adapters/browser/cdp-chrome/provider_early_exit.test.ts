import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunContext } from '../../../ports/context.ts';
import type { CdpBrowser } from './provider.ts';
import { CdpChromeProvider } from './provider.ts';

const noop = () => {};
const errors: Array<[string, unknown]> = [];
const ctx: RunContext = {
  profile: 'rajni',
  signal: new AbortController().signal,
  logger: {
    debug: noop,
    info: noop,
    warn: noop,
    error: (msg, data) => {
      errors.push([msg, data]);
    },
  },
  beat: noop,
};

const EXIT_MSG =
  'Chrome exited (code 0, signal none) 210ms after launch, before CDP port 9222';

test('a spawned Chrome that already exited fails the launch at once with its exit detail, and is killed', async () => {
  errors.length = 0;
  let connects = 0;
  const killed: Array<number | undefined> = [];
  const provider = new CdpChromeProvider({
    cdpReachable: async () => null,
    launchChrome: () => ({ pid: 77, earlyExit: () => EXIT_MSG }),
    killChrome: (pid) => {
      killed.push(pid);
      return true;
    },
    connectMaxWaitMs: 60_000,
    connectRetryMs: 1,
    connect: async () => {
      connects += 1;
      throw new Error('ECONNREFUSED');
    },
  });
  const started = Date.now();
  await assert.rejects(provider.launch(ctx), (err: Error) => {
    assert.equal(err.message, EXIT_MSG);
    assert.match(String(err.cause), /ECONNREFUSED/);
    return true;
  });
  assert.ok(Date.now() - started < 5_000, 'must not wait out the connect budget');
  assert.equal(connects, 1);
  assert.deepEqual(killed, [77]);
  assert.equal(errors[0]?.[0], 'cdp-chrome: spawned Chrome exited before CDP came up');
});

test('a spawned Chrome that is still alive keeps the retry loop going until connect succeeds', async () => {
  let connects = 0;
  const provider = new CdpChromeProvider({
    cdpReachable: async () => null,
    launchChrome: () => ({ pid: 77, earlyExit: () => undefined }),
    killChrome: () => true,
    connectMaxWaitMs: 60_000,
    connectRetryMs: 1,
    connect: async () => {
      connects += 1;
      if (connects < 3) throw new Error('ECONNREFUSED');
      return { newPage: async () => undefined as never } satisfies CdpBrowser;
    },
  });
  const handle = await provider.launch(ctx);
  assert.equal(handle.cdpUrl, 'http://127.0.0.1:9222');
  assert.equal(connects, 3);
});

test('a Chrome that exits only after one failed attempt still fails fast on the next check', async () => {
  let connects = 0;
  const provider = new CdpChromeProvider({
    cdpReachable: async () => null,
    launchChrome: () => ({
      pid: 77,
      earlyExit: () => (connects >= 2 ? EXIT_MSG : undefined),
    }),
    killChrome: () => true,
    connectMaxWaitMs: 60_000,
    connectRetryMs: 1,
    connect: async () => {
      connects += 1;
      throw new Error('ECONNREFUSED');
    },
  });
  await assert.rejects(provider.launch(ctx), { message: EXIT_MSG });
  assert.equal(connects, 2);
});
