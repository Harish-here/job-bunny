import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChromePidfile, ChromePidfileDeps } from './pidfile.ts';
import {
  chromePidfilePath,
  clearChromePidfile,
  defaultChromePidfileDeps,
  readChromePidfile,
  writeChromePidfile,
} from './pidfile.ts';

// Built via node:path's join (not a forward-slash literal) so the expected
// value tracks whatever separator the host platform's join() actually
// produces — chromePidfilePath is implemented with join too, so on the
// windows-latest CI runner (Task 1) both sides emit backslashes alike.
const PIDFILE_PATH = join('/repo/.chrome-debug', '.jobbunny-chrome.json');

test('chromePidfilePath joins userDataDir with the fixed pidfile name', () => {
  assert.equal(chromePidfilePath('/repo/.chrome-debug'), PIDFILE_PATH);
});

function fakeDeps(overrides: Partial<ChromePidfileDeps> = {}): ChromePidfileDeps {
  return {
    existsSync: () => false,
    readFileSync: () => {
      throw new Error('no file');
    },
    writeFileSync: () => {},
    mkdirSync: () => {},
    unlinkSync: () => {},
    pidIsAlive: () => true,
    now: () => new Date('2026-07-27T12:00:00.000Z'),
    ...overrides,
  };
}

test('writeChromePidfile writes the info as JSON to chromePidfilePath', () => {
  const writeCalls: Array<{ path: string; data: string }> = [];
  const deps = fakeDeps({
    writeFileSync: (path, data) => {
      writeCalls.push({ path, data });
    },
  });
  const info: ChromePidfile = {
    pid: 4242,
    port: 9222,
    startedAt: '2026-07-27T12:00:00.000Z',
  };
  writeChromePidfile('/repo/.chrome-debug', info, deps);

  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0]?.path, PIDFILE_PATH);
  assert.deepEqual(JSON.parse(writeCalls[0]?.data ?? '{}'), info);
});

test('writeChromePidfile creates userDataDir before writing (fresh clone has no .chrome-debug/)', () => {
  const order: string[] = [];
  const mkdirPaths: string[] = [];
  const deps = fakeDeps({
    mkdirSync: (path) => {
      order.push('mkdir');
      mkdirPaths.push(path);
    },
    writeFileSync: () => {
      order.push('write');
    },
  });

  writeChromePidfile(
    '/repo/.chrome-debug',
    { pid: 4242, port: 9222, startedAt: '2026-07-27T12:00:00.000Z' },
    deps,
  );

  assert.deepEqual(order, ['mkdir', 'write']);
  assert.deepEqual(mkdirPaths, ['/repo/.chrome-debug']);
});

test('writeChromePidfile propagates a write failure instead of swallowing it', () => {
  const deps = fakeDeps({
    writeFileSync: () => {
      throw new Error('EACCES');
    },
  });

  assert.throws(
    () =>
      writeChromePidfile(
        '/repo/.chrome-debug',
        { pid: 4242, port: 9222, startedAt: '2026-07-27T12:00:00.000Z' },
        deps,
      ),
    /EACCES/,
  );
});

test('round-trip: readChromePidfile returns exactly what writeChromePidfile wrote, for a live pid', () => {
  let stored: string | undefined;
  const deps = fakeDeps({
    existsSync: () => stored !== undefined,
    writeFileSync: (_path, data) => {
      stored = data;
    },
    readFileSync: () => {
      if (stored === undefined) throw new Error('no file');
      return stored;
    },
    pidIsAlive: () => true,
  });
  const info: ChromePidfile = {
    pid: 4242,
    port: 9222,
    startedAt: '2026-07-27T12:00:00.000Z',
  };
  writeChromePidfile('/repo/.chrome-debug', info, deps);

  const result = readChromePidfile('/repo/.chrome-debug', deps);
  assert.deepEqual(result, info);
});

test('readChromePidfile self-heals: deletes the file and returns undefined when the recorded pid is dead', () => {
  const unlinkCalls: string[] = [];
  const deps = fakeDeps({
    existsSync: () => true,
    readFileSync: () =>
      JSON.stringify({ pid: 4242, port: 9222, startedAt: '2026-07-27T12:00:00.000Z' }),
    unlinkSync: (path) => {
      unlinkCalls.push(path);
    },
    pidIsAlive: () => false,
  });

  const result = readChromePidfile('/repo/.chrome-debug', deps);

  assert.equal(result, undefined);
  assert.deepEqual(unlinkCalls, [PIDFILE_PATH]);
});

test('readChromePidfile deletes an unparseable file and returns undefined', () => {
  const unlinkCalls: string[] = [];
  const deps = fakeDeps({
    existsSync: () => true,
    readFileSync: () => '{ not valid json',
    unlinkSync: (path) => {
      unlinkCalls.push(path);
    },
  });

  const result = readChromePidfile('/repo/.chrome-debug', deps);

  assert.equal(result, undefined);
  assert.deepEqual(unlinkCalls, [PIDFILE_PATH]);
});

test('readChromePidfile deletes a pid file with an unparseable startedAt and returns undefined', () => {
  const unlinkCalls: string[] = [];
  const deps = fakeDeps({
    existsSync: () => true,
    readFileSync: () => JSON.stringify({ pid: 4242, port: 9222, startedAt: 'garbage' }),
    unlinkSync: (path) => {
      unlinkCalls.push(path);
    },
  });

  const result = readChromePidfile('/repo/.chrome-debug', deps);

  assert.equal(result, undefined);
  assert.deepEqual(unlinkCalls, [PIDFILE_PATH]);
});

test('readChromePidfile returns undefined without calling unlinkSync when the file is missing', () => {
  const unlinkCalls: string[] = [];
  const deps = fakeDeps({
    existsSync: () => false,
    unlinkSync: (path) => {
      unlinkCalls.push(path);
    },
  });

  const result = readChromePidfile('/repo/.chrome-debug', deps);

  assert.equal(result, undefined);
  assert.deepEqual(unlinkCalls, []);
});

test('clearChromePidfile unlinks an existing pidfile', () => {
  const unlinkCalls: string[] = [];
  const deps = fakeDeps({
    existsSync: () => true,
    unlinkSync: (path) => {
      unlinkCalls.push(path);
    },
  });

  clearChromePidfile('/repo/.chrome-debug', deps);

  assert.deepEqual(unlinkCalls, [PIDFILE_PATH]);
});

test('clearChromePidfile is a no-op when no pidfile exists', () => {
  const unlinkCalls: string[] = [];
  const deps = fakeDeps({
    existsSync: () => false,
    unlinkSync: (path) => {
      unlinkCalls.push(path);
    },
  });

  clearChromePidfile('/repo/.chrome-debug', deps);

  assert.deepEqual(unlinkCalls, []);
});

test('defaultChromePidfileDeps builds working deps against the real fs/process', () => {
  const deps = defaultChromePidfileDeps();
  assert.equal(typeof deps.existsSync, 'function');
  assert.equal(typeof deps.readFileSync, 'function');
  assert.equal(typeof deps.writeFileSync, 'function');
  // Not invoked — a real mkdirSync here would create a directory on the
  // machine running the suite.
  assert.equal(typeof deps.mkdirSync, 'function');
  assert.equal(typeof deps.unlinkSync, 'function');
  assert.equal(deps.pidIsAlive(process.pid), true);
  assert.ok(deps.now() instanceof Date);
});
