import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStderrLog, STDERR_LOG_NAME, watchEarlyExit } from './child_exit.ts';

const OPTS = { port: 9222, userDataDir: '/home/u/chrome', stderrCaptured: true };

function clock(...ticks: number[]): () => number {
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)] ?? 0;
}

test('openStderrLog opens <userDataDir>/<log name> for writing and returns the fd', () => {
  const calls: Array<[string, string]> = [];
  const fd = openStderrLog('/home/u/chrome', {
    openSync: (path, flags) => {
      calls.push([path, flags]);
      return 17;
    },
  });
  assert.equal(fd, 17);
  assert.deepEqual(calls, [[join('/home/u/chrome', STDERR_LOG_NAME), 'w']]);
});

test('openStderrLog returns undefined instead of throwing when the file cannot be opened', () => {
  const fd = openStderrLog('/nope', {
    openSync: () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(fd, undefined);
});

test('watchEarlyExit reports nothing while the child is alive', () => {
  const child = new EventEmitter();
  const probe = watchEarlyExit(child, OPTS, { readFileSync: () => 'x', nowMs: clock(0) });
  assert.equal(probe(), undefined);
});

test('watchEarlyExit reports status, elapsed time, port, dir and the stderr tail after exit', () => {
  const child = new EventEmitter();
  const probe = watchEarlyExit(child, OPTS, {
    readFileSync: () => 'Opening in existing browser session.\n',
    nowMs: clock(1000, 1210),
  });
  child.emit('exit', 0, null);
  const msg = probe();
  assert.match(msg ?? '', /^Chrome exited \(code 0, signal none\) 210ms after launch/);
  assert.match(msg ?? '', /CDP port 9222/);
  assert.match(msg ?? '', /user-data-dir \/home\/u\/chrome/);
  assert.match(msg ?? '', /stderr tail: Opening in existing browser session\.$/);
});

test('watchEarlyExit keeps only a bounded tail of a long stderr', () => {
  const child = new EventEmitter();
  const probe = watchEarlyExit(child, OPTS, {
    readFileSync: () => `HEAD${'x'.repeat(5000)}TAIL`,
    nowMs: clock(0),
  });
  child.emit('exit', 1, null);
  const msg = probe() ?? '';
  assert.ok(msg.endsWith('TAIL'));
  assert.ok(!msg.includes('HEAD'));
  assert.ok(msg.length < 2500);
});

test('watchEarlyExit labels empty, uncaptured and unreadable stderr', () => {
  const run = (opts: typeof OPTS, read: () => string) => {
    const child = new EventEmitter();
    const probe = watchEarlyExit(child, opts, { readFileSync: read, nowMs: clock(0) });
    child.emit('exit', null, 'SIGKILL');
    return probe() ?? '';
  };
  assert.match(
    run(OPTS, () => '  \n'),
    /stderr tail: \(empty\)$/,
  );
  assert.match(
    run({ ...OPTS, stderrCaptured: false }, () => 'x'),
    /\(not captured\)$/,
  );
  assert.match(
    run(OPTS, () => {
      throw new Error('EIO');
    }),
    /\(unreadable\)$/,
  );
  assert.match(
    run(OPTS, () => ''),
    /code none, signal SIGKILL/,
  );
});

test('watchEarlyExit treats a spawn error event as an early exit, and the first status wins', () => {
  const child = new EventEmitter();
  const probe = watchEarlyExit(child, OPTS, { readFileSync: () => '', nowMs: clock(0) });
  child.emit('error', new Error('spawn EACCES'));
  child.emit('exit', 1, null);
  assert.match(probe() ?? '', /^Chrome process error \(spawn EACCES\)/);
});

test('watchEarlyExit tolerates a child that cannot be watched (no on())', () => {
  const probe = watchEarlyExit({}, OPTS, { readFileSync: () => '', nowMs: clock(0) });
  assert.equal(probe(), undefined);
});
