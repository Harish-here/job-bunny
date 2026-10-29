import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunContext } from '../../../ports/context.ts';
import { ForeignChromeError } from './foreign/index.ts';
import type { ChromePidfileDeps } from './ownership/index.ts';
import type { CdpBrowser } from './provider.ts';
import { CdpChromeProvider } from './provider.ts';

const WS = 'ws://127.0.0.1:9222/devtools/browser/abc';
const OUR_DIR = '/home/me/.jobbunny/chrome';

function ctx(): RunContext {
  return {
    profile: 'rajni',
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
  };
}

function pidfileDeps(live: { ageMs: number } | undefined): ChromePidfileDeps {
  const now = new Date('2026-07-27T12:00:00.000Z');
  return {
    existsSync: () => live !== undefined,
    readFileSync: () =>
      JSON.stringify({
        pid: 5555,
        port: 9222,
        startedAt: new Date(now.getTime() - (live?.ageMs ?? 0)).toISOString(),
      }),
    writeFileSync: () => {},
    mkdirSync: () => {},
    unlinkSync: () => {},
    pidIsAlive: () => true,
    now: () => now,
  };
}

/** Provider wired with call recorders; `actualDir` is what the faked
 * SystemInfo.getInfo reports (undefined = unprovable). */
function setup(opts: {
  actualDir: string | undefined;
  pidfile: { ageMs: number } | undefined;
  read?: () => Promise<string | undefined>;
}) {
  const calls = { connect: 0, launch: 0, kill: 0, reads: [] as string[] };
  const provider = new CdpChromeProvider({
    port: 9222,
    userDataDir: OUR_DIR,
    cdpReachable: async () => ({ webSocketDebuggerUrl: WS }),
    pidfileDeps: pidfileDeps(opts.pidfile),
    ownership: {
      readUserDataDir: async (wsUrl) => {
        calls.reads.push(wsUrl);
        return opts.read ? opts.read() : opts.actualDir;
      },
      realpath: (p) => p,
      platform: 'darwin',
    },
    connect: async () => {
      calls.connect++;
      return { newPage: async () => ({}) as never } satisfies CdpBrowser;
    },
    launchChrome: () => {
      calls.launch++;
      return { pid: 7777 };
    },
    killChrome: () => {
      calls.kill++;
      return true;
    },
  });
  return { provider, calls };
}

test('ours + no pid file: attaches, never kills or launches', async () => {
  const { provider, calls } = setup({ actualDir: OUR_DIR, pidfile: undefined });
  await provider.launch(ctx());
  assert.deepEqual([calls.connect, calls.launch, calls.kill], [1, 0, 0]);
  assert.deepEqual(calls.reads, [WS]);
});

test('ours + fresh live pid file: reuses without kill or launch', async () => {
  const { provider, calls } = setup({ actualDir: OUR_DIR, pidfile: { ageMs: 60_000 } });
  await provider.launch(ctx());
  assert.deepEqual([calls.connect, calls.launch, calls.kill], [1, 0, 0]);
});

test('ours + stale live pid file: recycles (kill + relaunch)', async () => {
  const { provider, calls } = setup({
    actualDir: OUR_DIR,
    pidfile: { ageMs: 48 * 3_600_000 },
  });
  await provider.launch(ctx());
  assert.deepEqual([calls.connect, calls.launch, calls.kill], [1, 1, 1]);
});

test('foreign + no pid file: throws ForeignChromeError naming the dir, never connects/launches/kills', async () => {
  const dir = '/Users/me/Library/Application Support/Google/Chrome';
  const { provider, calls } = setup({ actualDir: dir, pidfile: undefined });
  await assert.rejects(provider.launch(ctx()), (err: unknown) => {
    assert.ok(err instanceof ForeignChromeError);
    assert.equal(err.port, 9222);
    assert.equal(err.expectedDir, OUR_DIR);
    assert.equal(err.foreignDir, dir);
    assert.equal(
      err.message,
      `Chrome on CDP port :9222 is not Job Bunny's — it runs --user-data-dir=${dir} (expected ${OUR_DIR}). Job Bunny will not attach to or close it. Close that Chrome, then rerun.`,
    );
    return true;
  });
  assert.deepEqual([calls.connect, calls.launch, calls.kill], [0, 0, 0]);
});

test('foreign + live (even stale) pid file: throws and never kills', async () => {
  const { provider, calls } = setup({
    actualDir: '/Users/me/other',
    pidfile: { ageMs: 48 * 3_600_000 },
  });
  await assert.rejects(provider.launch(ctx()), ForeignChromeError);
  assert.deepEqual([calls.connect, calls.launch, calls.kill], [0, 0, 0]);
});

test('unprovable (dir unreadable, reader throws): foreign with "an unknown user-data-dir"', async () => {
  for (const read of [
    async () => undefined,
    async () => {
      throw new Error('socket blew up');
    },
  ]) {
    const { provider, calls } = setup({ actualDir: undefined, pidfile: undefined, read });
    await assert.rejects(provider.launch(ctx()), (err: unknown) => {
      assert.ok(err instanceof ForeignChromeError);
      assert.equal(err.foreignDir, undefined);
      assert.match(err.message, /--user-data-dir=an unknown user-data-dir \(expected /);
      return true;
    });
    assert.deepEqual([calls.connect, calls.launch, calls.kill], [0, 0, 0]);
  }
});

test('unprovable (no webSocketDebuggerUrl in /json/version): foreign without reading', async () => {
  const calls = { reads: 0 };
  const provider = new CdpChromeProvider({
    port: 9222,
    userDataDir: OUR_DIR,
    cdpReachable: async () => ({ Browser: 'Chrome' }),
    pidfileDeps: pidfileDeps(undefined),
    ownership: {
      readUserDataDir: async () => {
        calls.reads++;
        return OUR_DIR;
      },
      realpath: (p) => p,
      platform: 'darwin',
    },
  });
  await assert.rejects(provider.launch(ctx()), ForeignChromeError);
  assert.equal(calls.reads, 0);
});
