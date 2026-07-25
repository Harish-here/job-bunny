/**
 * main.test.ts (P8) — TDD for the `main` dispatcher: argv parsing +
 * command dispatch only. Every command is a FAKE injected via `MainDeps`;
 * no real `run`/`doctor` command (and therefore no `wire`/adapters) is
 * exercised here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from './main.ts';

function captureStderr(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s: string) => lines.push(s) };
}

test('main: dispatches "run" to the injected run command with parsed options', async () => {
  let received: unknown;
  const stderr = captureStderr();
  const code = await main(['run', '--profile', 'rajni'], {
    commands: {
      run: async (opts) => {
        received = opts;
        return 0;
      },
      doctor: async () => 0,
    },
    stderr: stderr.write,
  });
  assert.equal(code, 0);
  assert.deepEqual(received, { profile: 'rajni', resume: false, headless: false });
});

test('main: dispatches "doctor" to the injected doctor command', async () => {
  let called = false;
  const code = await main(['doctor', '--profile', 'rajni'], {
    commands: {
      run: async () => 0,
      doctor: async (opts) => {
        called = true;
        assert.equal(opts.profile, 'rajni');
        return 0;
      },
    },
  });
  assert.equal(code, 0);
  assert.ok(called);
});

test('main: parses --resume and --headless flags', async () => {
  let received: unknown;
  const code = await main(['run', '--profile', 'rajni', '--resume', '--headless'], {
    commands: {
      run: async (opts) => {
        received = opts;
        return 0;
      },
      doctor: async () => 0,
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(received, { profile: 'rajni', resume: true, headless: true });
});

test('main: an unknown command prints usage to stderr and returns 2', async () => {
  const stderr = captureStderr();
  const code = await main(['bogus'], {
    commands: { run: async () => 0, doctor: async () => 0 },
    stderr: stderr.write,
  });
  assert.equal(code, 2);
  assert.ok(stderr.lines.length > 0);
});

test('main: no command at all prints usage to stderr and returns 2', async () => {
  const stderr = captureStderr();
  const code = await main([], {
    commands: { run: async () => 0, doctor: async () => 0 },
    stderr: stderr.write,
  });
  assert.equal(code, 2);
  assert.ok(stderr.lines.length > 0);
});

test('main: missing --profile for "run" returns 2', async () => {
  const stderr = captureStderr();
  const code = await main(['run'], {
    commands: { run: async () => 0, doctor: async () => 0 },
    stderr: stderr.write,
  });
  assert.equal(code, 2);
  assert.ok(stderr.lines.length > 0);
});

test('main: missing --profile for "doctor" returns 2', async () => {
  const code = await main(['doctor'], {
    commands: { run: async () => 0, doctor: async () => 0 },
  });
  assert.equal(code, 2);
});

test("main: returns the command's own numeric exit code", async () => {
  const code = await main(['run', '--profile', 'rajni'], {
    commands: {
      run: async () => 1,
      doctor: async () => 0,
    },
  });
  assert.equal(code, 1);
});

test('main: a thrown error from a command is caught, printed to stderr, and returns 1', async () => {
  const stderr = captureStderr();
  const code = await main(['run', '--profile', 'rajni'], {
    commands: {
      run: async () => {
        throw new Error('boom');
      },
      doctor: async () => 0,
    },
    stderr: stderr.write,
  });
  assert.equal(code, 1);
  assert.ok(stderr.lines.some((l) => l.includes('boom')));
});
