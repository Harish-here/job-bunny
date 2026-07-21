import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildLaunchArgv,
  CHROME_PATH_CANDIDATES,
  killChrome,
  launchChrome,
  resolveChromePath,
} from './launcher.ts';

test('resolveChromePath returns the first candidate that exists', () => {
  const existing = new Set(['/Applications/Chromium.app/Contents/MacOS/Chromium']);
  const found = resolveChromePath(CHROME_PATH_CANDIDATES, {
    existsSync: (path) => existing.has(path),
  });
  assert.equal(found, '/Applications/Chromium.app/Contents/MacOS/Chromium');
});

test('resolveChromePath prefers earlier candidates over later ones', () => {
  const existing = new Set(CHROME_PATH_CANDIDATES);
  const found = resolveChromePath(CHROME_PATH_CANDIDATES, {
    existsSync: (path) => existing.has(path),
  });
  assert.equal(found, CHROME_PATH_CANDIDATES[0]);
});

test('resolveChromePath throws a clear error naming every path checked when none exist', () => {
  assert.throws(
    () => resolveChromePath(['/a', '/b'], { existsSync: () => false }),
    /no Chrome executable found \(checked: \/a, \/b\)/,
  );
});

test('buildLaunchArgv sets --remote-debugging-port and --user-data-dir, nothing else', () => {
  const argv = buildLaunchArgv({ port: 9222, userDataDir: '/repo/.chrome-debug' });
  assert.deepEqual(argv, [
    '--remote-debugging-port=9222',
    '--user-data-dir=/repo/.chrome-debug',
  ]);
});

test('launchChrome resolves the chrome path, builds argv, spawns detached+unref, and returns the pid', () => {
  const spawnCalls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const proc = launchChrome(
    { port: 9333, userDataDir: '/repo/.chrome-debug', candidates: ['/only/chrome'] },
    {
      existsSync: (path) => path === '/only/chrome',
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { pid: 4242, unref: () => {} };
      },
    },
  );
  assert.equal(proc.pid, 4242);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]?.command, '/only/chrome');
  assert.deepEqual(spawnCalls[0]?.args, [
    '--remote-debugging-port=9333',
    '--user-data-dir=/repo/.chrome-debug',
  ]);
  assert.deepEqual(spawnCalls[0]?.options, { detached: true, stdio: 'ignore' });
});

test('launchChrome unrefs the spawned child so it never keeps the event loop alive', () => {
  let unrefCalled = false;
  launchChrome(
    { port: 9222, candidates: ['/only/chrome'] },
    {
      existsSync: () => true,
      spawn: () => ({
        pid: 1,
        unref: () => {
          unrefCalled = true;
        },
      }),
    },
  );
  assert.equal(unrefCalled, true);
});

test('launchChrome propagates the resolveChromePath error when no candidate exists', () => {
  assert.throws(
    () =>
      launchChrome(
        { port: 9222, candidates: ['/nope'] },
        { existsSync: () => false, spawn: () => ({ pid: 1, unref: () => {} }) },
      ),
    /no Chrome executable found/,
  );
});

test('killChrome sends SIGTERM to the spawned pid by default', () => {
  const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const result = killChrome(4242, {
    env: {},
    kill: (pid, signal) => {
      calls.push({ pid, signal });
    },
  });
  assert.equal(result, true);
  assert.deepEqual(calls, [{ pid: 4242, signal: 'SIGTERM' }]);
});

test('killChrome does nothing when JOBBUNNY_KEEP_BROWSER=1', () => {
  const calls: number[] = [];
  const result = killChrome(4242, {
    env: { JOBBUNNY_KEEP_BROWSER: '1' },
    kill: (pid) => {
      calls.push(pid);
    },
  });
  assert.equal(result, false);
  assert.deepEqual(calls, []);
});

test('killChrome is a no-op when there is no pid to kill', () => {
  const calls: number[] = [];
  const result = killChrome(undefined, {
    env: {},
    kill: (pid) => {
      calls.push(pid);
    },
  });
  assert.equal(result, false);
  assert.deepEqual(calls, []);
});

test('killChrome treats an already-gone process as a handled no-op, not a throw', () => {
  const result = killChrome(4242, {
    env: {},
    kill: () => {
      throw new Error('ESRCH');
    },
  });
  assert.equal(result, false);
});
