import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunContext } from '../../../ports/context.ts';
import type { CdpBrowser } from './provider.ts';
import { CdpChromeProvider } from './provider.ts';

const noop = () => {};
const ctx: RunContext = {
  profile: 'rajni',
  signal: new AbortController().signal,
  logger: { debug: noop, info: noop, warn: noop, error: noop },
  beat: noop,
};

test('a connect attempt that loses the timeout race is closed when it resolves late', async () => {
  let closed = 0;
  let resolveLate!: (b: CdpBrowser) => void;
  const provider = new CdpChromeProvider({
    cdpReachable: async () => null,
    launchChrome: () => ({ pid: 1 }),
    killChrome: () => true,
    connectMaxWaitMs: 20,
    connectRetryMs: 1,
    connect: () =>
      new Promise<CdpBrowser>((r) => {
        resolveLate = r;
      }),
  });
  await assert.rejects(provider.launch(ctx), /gave up connecting/);
  resolveLate({
    newPage: async () => undefined as never,
    close: async () => {
      closed += 1;
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(closed, 1);
});
