import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunContext } from '../../../ports/context.ts';
import { CdpChromeProvider } from './provider.ts';

const noop = () => {};
const errors: Array<[string, Record<string, unknown> | undefined]> = [];
const ctx: RunContext = {
  profile: 'rajni',
  signal: new AbortController().signal,
  logger: {
    debug: noop,
    info: noop,
    warn: noop,
    error: (msg, data) => {
      errors.push([msg, data as Record<string, unknown> | undefined]);
    },
  },
  beat: noop,
};

function giveUpProvider(version: unknown | null): CdpChromeProvider {
  let probes = 0;
  return new CdpChromeProvider({
    // First probe (launch): nothing listening → spawn. Later probes: the
    // spawned Chrome answers /json/version while connect keeps failing.
    cdpReachable: async () => (probes++ === 0 ? null : version),
    launchChrome: () => ({ pid: 77, earlyExit: () => undefined }),
    killChrome: () => true,
    connectMaxWaitMs: 20,
    connectRetryMs: 1,
    connect: async () => {
      throw new Error('connect attempt exceeded ~8.5s');
    },
  });
}

test('the gave-up log names the Chrome version reported by /json/version', async () => {
  errors.length = 0;
  await assert.rejects(
    giveUpProvider({ Browser: 'Chrome/157.0.8103.78' }).launch(ctx),
    /gave up connecting/,
  );
  const gaveUp = errors.find(
    ([m]) => m === 'cdp-chrome: gave up connecting to Chrome CDP',
  );
  assert.equal(gaveUp?.[1]?.chromeVersion, 'Chrome/157.0.8103.78');
});

test('the gave-up log still fires, version undefined, when /json/version is unreachable', async () => {
  errors.length = 0;
  await assert.rejects(giveUpProvider(null).launch(ctx), /gave up connecting/);
  const gaveUp = errors.find(
    ([m]) => m === 'cdp-chrome: gave up connecting to Chrome CDP',
  );
  assert.ok(gaveUp);
  assert.equal(gaveUp?.[1]?.chromeVersion, undefined);
});
