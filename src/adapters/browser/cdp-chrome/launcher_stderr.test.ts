import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { LauncherDeps } from './launcher.ts';
import { launchChrome } from './launcher.ts';
import type { ChromePidfileDeps } from './ownership/index.ts';

const pidfileDeps: ChromePidfileDeps = {
  existsSync: () => false,
  readFileSync: () => '',
  writeFileSync: () => {},
  mkdirSync: () => {},
  unlinkSync: () => {},
  pidIsAlive: () => true,
  now: () => new Date('2026-11-04T08:38:23.000Z'),
};

function harness(over: Partial<LauncherDeps> = {}) {
  const child = Object.assign(new EventEmitter(), { pid: 4242, unref: () => {} });
  const spawnOptions: unknown[] = [];
  const closed: number[] = [];
  const deps: LauncherDeps = {
    existsSync: (p) => p === '/only/chrome',
    spawn: (_c, _a, options) => {
      spawnOptions.push(options);
      return child;
    },
    env: { JOBBUNNY_SKIP_SESSION_CLEAR: '1' },
    pidfileDeps,
    openSync: () => 9,
    closeSync: (fd) => {
      closed.push(fd);
    },
    readFileSync: () => 'singleton handoff',
    nowMs: () => 0,
    ...over,
  };
  const launch = (captureStderr?: boolean) =>
    launchChrome(
      { port: 9222, userDataDir: '/ud', candidates: ['/only/chrome'], captureStderr },
      deps,
    );
  return { child, spawnOptions, closed, launch };
}

test('captureStderr routes the child stderr to the opened fd and closes the parent copy', () => {
  const h = harness();
  h.launch(true);
  assert.deepEqual(h.spawnOptions, [{ detached: true, stdio: ['ignore', 'ignore', 9] }]);
  assert.deepEqual(h.closed, [9]);
});

test('without captureStderr stderr stays ignored and no fd is opened', () => {
  const h = harness({
    openSync: () => {
      throw new Error('must not open');
    },
  });
  h.launch();
  assert.deepEqual(h.spawnOptions, [{ detached: true, stdio: 'ignore' }]);
  assert.deepEqual(h.closed, []);
});

test('an unopenable stderr log degrades to ignored stderr, never a failed launch', () => {
  const h = harness({
    openSync: () => {
      throw new Error('ENOENT');
    },
  });
  const proc = h.launch(true);
  assert.deepEqual(h.spawnOptions, [{ detached: true, stdio: 'ignore' }]);
  h.child.emit('exit', 0, null);
  assert.match(proc.earlyExit?.() ?? '', /stderr tail: \(not captured\)/);
});

test('the fd is closed even when spawn throws', () => {
  const h = harness({
    spawn: () => {
      throw new Error('spawn blew up');
    },
  });
  assert.throws(() => h.launch(true), /spawn blew up/);
  assert.deepEqual(h.closed, [9]);
});

test('the returned handle reports an early exit only once the child has exited', () => {
  const h = harness();
  const proc = h.launch(true);
  assert.equal(proc.pid, 4242);
  assert.equal(proc.earlyExit?.(), undefined);
  h.child.emit('exit', 0, null);
  assert.match(
    proc.earlyExit?.() ?? '',
    /Chrome exited \(code 0.*stderr tail: singleton handoff$/,
  );
});
