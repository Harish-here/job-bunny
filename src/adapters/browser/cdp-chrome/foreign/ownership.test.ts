import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OwnershipDeps } from './ownership.ts';
import { assertOurChrome, ForeignChromeError } from './ownership.ts';

const WS = 'ws://127.0.0.1:9222/devtools/browser/abc';
const OUR_DIR = '/home/me/.jobbunny/chrome';
const live = { webSocketDebuggerUrl: WS };

function deps(over: Partial<OwnershipDeps> & { actualDir?: string } = {}) {
  const reads: string[] = [];
  const d: OwnershipDeps = {
    readUserDataDir: async (wsUrl) => {
      reads.push(wsUrl);
      return over.actualDir;
    },
    realpath: (p) => p,
    platform: 'darwin',
    ...over,
  };
  return { d, reads };
}

function run(
  d: OwnershipDeps,
  over: { version?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
) {
  return assertOurChrome({
    version: live,
    port: 9222,
    userDataDir: OUR_DIR,
    signal: new AbortController().signal,
    deps: d,
    ...over,
  });
}

test('match: resolves and reads the probed ws URL', async () => {
  const { d, reads } = deps({ actualDir: OUR_DIR });
  await run(d);
  assert.deepEqual(reads, [WS]);
});

test('mismatch: ForeignChromeError names port, both dirs, with the exact text', async () => {
  const foreign = '/Users/me/Library/Application Support/Google/Chrome';
  const { d } = deps({ actualDir: foreign });
  await assert.rejects(run(d), (err: unknown) => {
    assert.ok(err instanceof ForeignChromeError);
    assert.equal(err.port, 9222);
    assert.equal(err.foreignDir, foreign);
    assert.equal(err.expectedDir, OUR_DIR);
    assert.equal(
      err.message,
      `Chrome on CDP port :9222 is not Job Bunny's — it runs --user-data-dir=${foreign} (expected ${OUR_DIR}). Job Bunny will not attach to or close it. Close that Chrome, then rerun.`,
    );
    return true;
  });
});

test('unprovable (reader returns undefined or throws): foreign with unknown dir', async () => {
  for (const readUserDataDir of [
    async () => undefined,
    async () => {
      throw new Error('socket blew up');
    },
  ]) {
    const { d } = deps({ readUserDataDir });
    await assert.rejects(run(d), (err: unknown) => {
      assert.ok(err instanceof ForeignChromeError);
      assert.equal(err.foreignDir, undefined);
      assert.match(err.message, /--user-data-dir=an unknown user-data-dir \(expected /);
      return true;
    });
  }
});

test('missing webSocketDebuggerUrl (or non-object version): foreign without reading', async () => {
  for (const version of [{ Browser: 'Chrome' }, { webSocketDebuggerUrl: 7 }, null, 'x']) {
    const { d, reads } = deps({ actualDir: OUR_DIR });
    await assert.rejects(run(d, { version }), ForeignChromeError);
    assert.deepEqual(reads, []);
  }
});

test('equivalent paths match: trailing slash, symlink realpath, unresolvable realpath', async () => {
  const sym = deps({
    actualDir: '/private/home/me/.jobbunny/chrome/',
    realpath: (p) => p.replace(/^\/home\//, '/private/home/'),
  });
  await run(sym.d);
  const missing = deps({
    actualDir: `${OUR_DIR}/`,
    realpath: () => {
      throw new Error('ENOENT');
    },
  });
  await run(missing.d);
});

test('win32: comparison is case-insensitive; elsewhere case-sensitive', async () => {
  await run(deps({ actualDir: OUR_DIR.toUpperCase(), platform: 'win32' }).d);
  await assert.rejects(
    run(deps({ actualDir: OUR_DIR.toUpperCase() }).d),
    ForeignChromeError,
  );
});

test('caller abort during the read: rethrows signal.reason, not ForeignChromeError', async () => {
  const ac = new AbortController();
  const reason = new Error('run deadline');
  const { d } = deps({
    readUserDataDir: (_ws, s) =>
      new Promise((_res, rej) => {
        s.addEventListener('abort', () => rej(s.reason));
        ac.abort(reason);
      }),
  });
  await assert.rejects(run(d, { signal: ac.signal }), (err: unknown) => {
    assert.equal(err, reason);
    return true;
  });
});

test('caller abort after the read returned a foreign dir: still the abort reason', async () => {
  const ac = new AbortController();
  const { d } = deps({
    readUserDataDir: async () => {
      ac.abort();
      return '/Users/me/other';
    },
  });
  await assert.rejects(run(d, { signal: ac.signal }), (err: unknown) => {
    assert.ok(!(err instanceof ForeignChromeError));
    assert.equal((err as Error).name, 'AbortError');
    return true;
  });
});

test('caller abort with undefined reason: throws an AbortError', async () => {
  const { d } = deps({ actualDir: OUR_DIR });
  const real = AbortSignal.abort();
  Object.defineProperty(real, 'reason', { value: undefined });
  await assert.rejects(run(d, { signal: real }), (err: unknown) => {
    assert.ok(err instanceof DOMException);
    assert.equal(err.name, 'AbortError');
    return true;
  });
});

test('internal timeout (caller signal live): ForeignChromeError, not an abort', async () => {
  const { d } = deps({
    readUserDataDir: (_ws, s) =>
      new Promise((_res, rej) => s.addEventListener('abort', () => rej(s.reason))),
  });
  await assert.rejects(run(d, { timeoutMs: 20 }), (err: unknown) => {
    assert.ok(err instanceof ForeignChromeError);
    assert.equal(err.foreignDir, undefined);
    return true;
  });
});
