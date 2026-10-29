import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Logger, RunContext } from '../../../../ports/context.ts';
import type { CdpBrowser } from '../provider.ts';
import { CdpChromeBrowserHandle } from './browser_handle.ts';

function ctxWithWarns(): { ctx: RunContext; warns: string[] } {
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (msg) => {
      warns.push(msg);
    },
    error() {},
  };
  return {
    warns,
    ctx: { profile: 'rajni', signal: new AbortController().signal, logger, beat() {} },
  };
}

function makeHandle(opts: {
  browser: CdpBrowser;
  ownsProcess: boolean;
  kill?: () => boolean | Promise<boolean>;
  disconnectTimeoutMs?: number;
}) {
  const { ctx, warns } = ctxWithWarns();
  const killed: Array<number | undefined> = [];
  const handle = new CdpChromeBrowserHandle(
    'http://127.0.0.1:1',
    opts.browser,
    ctx,
    4242,
    async (pid) => {
      killed.push(pid);
      return opts.kill ? opts.kill() : true;
    },
    undefined,
    '/tmp/udd',
    {} as never,
    opts.ownsProcess,
    opts.disconnectTimeoutMs,
  );
  return { handle, killed, warns };
}

test('attached close() disconnects and does not kill Chrome', async () => {
  let closed = 0;
  const { handle, killed } = makeHandle({
    browser: {
      newPage: async () => undefined as never,
      close: async () => {
        closed += 1;
      },
    },
    ownsProcess: false,
  });
  await handle.close();
  assert.equal(closed, 1);
  assert.deepEqual(killed, []);
});

test('owned close() kills the pid and also disconnects', async () => {
  const order: string[] = [];
  const { handle, killed } = makeHandle({
    browser: {
      newPage: async () => undefined as never,
      close: async () => {
        order.push('close');
      },
    },
    ownsProcess: true,
    kill: () => {
      order.push('kill');
      return true;
    },
  });
  await handle.close();
  assert.deepEqual(killed, [4242]);
  assert.deepEqual(order, ['kill', 'close']);
});

test('owned close() still disconnects when the kill throws, and re-throws the kill error', async () => {
  let closed = 0;
  const { handle } = makeHandle({
    browser: {
      newPage: async () => undefined as never,
      close: async () => {
        closed += 1;
      },
    },
    ownsProcess: true,
    kill: () => {
      throw new Error('kill boom');
    },
  });
  await assert.rejects(handle.close(), /kill boom/);
  assert.equal(closed, 1);
});

test('a rejecting disconnect is swallowed and logged at warn', async () => {
  const { handle, warns } = makeHandle({
    browser: {
      newPage: async () => undefined as never,
      close: async () => {
        throw new Error('already closed');
      },
    },
    ownsProcess: false,
  });
  await handle.close();
  assert.equal(warns.length, 1);
});

test('a never-resolving disconnect is bounded by the timeout', async () => {
  const { handle, warns } = makeHandle({
    browser: {
      newPage: async () => undefined as never,
      close: () => new Promise(() => {}),
    },
    ownsProcess: false,
    disconnectTimeoutMs: 20,
  });
  const start = Date.now();
  await handle.close();
  assert.ok(Date.now() - start < 1000, 'close() must return promptly');
  assert.equal(warns.length, 1);
});

test('a browser without close() (test fakes) is a quiet no-op', async () => {
  const { handle, warns } = makeHandle({
    browser: { newPage: async () => undefined as never },
    ownsProcess: false,
  });
  await handle.close();
  assert.deepEqual(warns, []);
});
