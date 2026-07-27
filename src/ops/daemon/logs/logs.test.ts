import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  daemonLogPath,
  defaultLogDeps,
  jobbunnyLogDir,
  LOG_ROTATE_BYTES,
  type LogDeps,
  openAppendFd,
  rotateIfLarge,
  runsLogPath,
} from './logs.ts';

function fakeDeps(sizes: Record<string, number> = {}): LogDeps & { _calls: string[] } {
  const calls: string[] = [];
  const existing = new Set(Object.keys(sizes));
  const dirs = new Set<string>();
  return {
    _calls: calls,
    existsSync: (p) => existing.has(p) || dirs.has(p),
    mkdirSync: (p) => {
      calls.push(`mkdir:${p}`);
      dirs.add(p);
    },
    statSync: (p) => ({ size: sizes[p] ?? 0 }),
    renameSync: (from, to) => {
      calls.push(`rename:${from}->${to}`);
      existing.delete(from);
      existing.add(to);
    },
    openSync: (p, flags) => {
      calls.push(`open:${p}:${flags}`);
      return 99;
    },
    closeSync: (fd) => {
      calls.push(`close:${fd}`);
    },
  };
}

// A home directory is an argument here, not an expectation — the composed
// expectations below go through `join`, which is what the 3-OS CI matrix
// requires (a POSIX literal fails on windows-latest).
const HOME = '/Users/rajni';

test('jobbunnyLogDir composes <home>/.jobbunny/logs', () => {
  assert.equal(jobbunnyLogDir(HOME), join(HOME, '.jobbunny', 'logs'));
});

test('daemonLogPath and runsLogPath compose under jobbunnyLogDir', () => {
  assert.equal(daemonLogPath(HOME), join(HOME, '.jobbunny', 'logs', 'daemon.log'));
  assert.equal(runsLogPath(HOME), join(HOME, '.jobbunny', 'logs', 'runs.log'));
});

test('rotateIfLarge is a no-op when the file is under the threshold', () => {
  const deps = fakeDeps({ '/fake/runs.log': LOG_ROTATE_BYTES - 1 });
  rotateIfLarge('/fake/runs.log', deps);
  assert.deepEqual(deps._calls, []);
});

test('rotateIfLarge renames to <path>.1 when the file is over the threshold', () => {
  const deps = fakeDeps({ '/fake/runs.log': LOG_ROTATE_BYTES + 1 });
  rotateIfLarge('/fake/runs.log', deps);
  assert.deepEqual(deps._calls, ['rename:/fake/runs.log->/fake/runs.log.1']);
});

test('rotateIfLarge is a no-op when the file is missing', () => {
  const deps = fakeDeps();
  rotateIfLarge('/fake/runs.log', deps);
  assert.deepEqual(deps._calls, []);
});

test('openAppendFd creates the log directory when absent, then opens with flag "a"', () => {
  const deps = fakeDeps();
  const fd = openAppendFd('/fake/.jobbunny/logs/daemon.log', deps);
  assert.equal(fd, 99);
  assert.deepEqual(deps._calls, [
    'mkdir:/fake/.jobbunny/logs',
    'open:/fake/.jobbunny/logs/daemon.log:a',
  ]);
});

test('defaultLogDeps: builds a working real-fs deps object shape', () => {
  const deps = defaultLogDeps();
  assert.equal(typeof deps.existsSync, 'function');
  assert.equal(typeof deps.openSync, 'function');
  assert.equal(typeof deps.closeSync, 'function');
});
