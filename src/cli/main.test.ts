/**
 * main.test.ts (P8) — TDD for the `main` dispatcher: argv parsing +
 * command dispatch only. Every command is a FAKE injected via `MainDeps`;
 * no real `run`/`doctor` command (and therefore no `wire`/adapters) is
 * exercised here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CommandFn, main } from './main.ts';

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
  assert.deepEqual(received, {
    profile: 'rajni',
    resume: false,
    headless: false,
    dryRun: false,
  });
});

test('main: parses --dry-run for "run"', async () => {
  let received: unknown;
  const code = await main(['run', '--profile', 'rajni', '--dry-run'], {
    commands: {
      run: async (opts) => {
        received = opts;
        return 0;
      },
      doctor: async () => 0,
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(received, {
    profile: 'rajni',
    resume: false,
    headless: false,
    dryRun: true,
  });
});

test('main: parses --run-cap-ms for "run"', async () => {
  let received: unknown;
  const code = await main(['run', '--profile', 'rajni', '--run-cap-ms', '42000'], {
    commands: {
      run: async (opts) => {
        received = opts;
        return 0;
      },
      doctor: async () => 0,
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(received, {
    profile: 'rajni',
    resume: false,
    headless: false,
    dryRun: false,
    runCapMs: 42_000,
  });
});

test('main: "run" without --run-cap-ms omits runCapMs entirely (not undefined)', async () => {
  let received: unknown;
  await main(['run', '--profile', 'rajni'], {
    commands: {
      run: async (opts) => {
        received = opts;
        return 0;
      },
      doctor: async () => 0,
    },
  });
  assert.equal((received as { runCapMs?: number }).runCapMs, undefined);
  assert.equal(Object.hasOwn(received as object, 'runCapMs'), false);
});

test('main: a non-numeric --run-cap-ms returns 2', async () => {
  const stderr = captureStderr();
  const code = await main(['run', '--profile', 'rajni', '--run-cap-ms', 'nope'], {
    commands: { run: async () => 0, doctor: async () => 0 },
    stderr: stderr.write,
  });
  assert.equal(code, 2);
  assert.match(stderr.lines.join('\n'), /--run-cap-ms/);
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
  assert.deepEqual(received, {
    profile: 'rajni',
    resume: true,
    headless: true,
    dryRun: false,
  });
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

// --- subcommand dispatch (P8 Task 4 tail) ---

/** Records what a named command was invoked with, so a test can assert the
 * argv → options translation without exercising the real command. */
function spy(): { calls: Array<[string, unknown]>; make: (name: string) => CommandFn } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    make:
      (name: string): CommandFn =>
      async (opts) => {
        calls.push([name, opts]);
        return 0;
      },
  };
}

test('main: "reconcile" dispatches with just the profile', async () => {
  const s = spy();
  const code = await main(['reconcile', '--profile', 'rajni'], {
    commands: { reconcile: s.make('reconcile') },
  });
  assert.equal(code, 0);
  assert.deepEqual(s.calls, [['reconcile', { profile: 'rajni' }]]);
});

test('main: "stage <name>" passes the positional through as the stage name', async () => {
  const s = spy();
  const code = await main(['stage', 'filter', '--profile', 'rajni'], {
    commands: { stage: s.make('stage') },
  });
  assert.equal(code, 0);
  assert.deepEqual(s.calls, [['stage', { profile: 'rajni', stage: 'filter' }]]);
});

test('main: "stage" without a stage name returns 2', async () => {
  const code = await main(['stage', '--profile', 'rajni'], {
    commands: { stage: async () => 0 },
    stderr: () => {},
  });
  assert.equal(code, 2);
});

test('main: "routine cleanup" passes the positional through as the routine name', async () => {
  const s = spy();
  const code = await main(['routine', 'cleanup', '--profile', 'rajni'], {
    commands: { routine: s.make('routine') },
  });
  assert.equal(code, 0);
  assert.deepEqual(s.calls, [['routine', { profile: 'rajni', routine: 'cleanup' }]]);
});

test('main: an unknown serve action returns 2, naming "start", "stop", or "status"', async () => {
  const stderr = captureStderr();
  const code = await main(['serve', 'bogus'], {
    commands: { serve: async () => 0 },
    stderr: stderr.write,
  });
  assert.equal(code, 2);
  assert.match(stderr.lines.join('\n'), /"start", "stop", or "status"/);
});

test('main: an unknown autostart action returns 2, naming "enable" or "disable"', async () => {
  const stderr = captureStderr();
  const code = await main(['autostart', 'bogus'], {
    commands: { autostart: async () => 0 },
    stderr: stderr.write,
  });
  assert.equal(code, 2);
  assert.match(stderr.lines.join('\n'), /"enable" or "disable"/);
});

test('main: "lane add-url <url> [label]" passes url and label positionally', async () => {
  const s = spy();
  const code = await main(
    ['lane', 'add-url', 'https://example.com/x', 'My Label', '--profile', 'rajni'],
    { commands: { lane: s.make('lane') } },
  );
  assert.equal(code, 0);
  assert.deepEqual(s.calls, [
    ['lane', { profile: 'rajni', url: 'https://example.com/x', label: 'My Label' }],
  ]);
});

test('main: "lane add-url" omits label entirely when none is given', async () => {
  const s = spy();
  await main(['lane', 'add-url', 'https://example.com/x', '--profile', 'rajni'], {
    commands: { lane: s.make('lane') },
  });
  assert.deepEqual(s.calls, [
    ['lane', { profile: 'rajni', url: 'https://example.com/x' }],
  ]);
});

test('main: "lane add-url" without a url returns 2', async () => {
  const code = await main(['lane', 'add-url', '--profile', 'rajni'], {
    commands: { lane: async () => 0 },
    stderr: () => {},
  });
  assert.equal(code, 2);
});

test('main: "profile build" dispatches with the profile', async () => {
  const s = spy();
  const code = await main(['profile', 'build', '--profile', 'newbie'], {
    commands: { profile: s.make('profile') },
  });
  assert.equal(code, 0);
  assert.deepEqual(s.calls, [['profile', { action: 'build', profile: 'newbie' }]]);
});

test('main: "profile remove" carries --force through', async () => {
  const s = spy();
  await main(['profile', 'remove', '--profile', 'newbie', '--force'], {
    commands: { profile: s.make('profile') },
  });
  assert.deepEqual(s.calls, [
    ['profile', { action: 'remove', profile: 'newbie', force: true }],
  ]);
});

test('main: "profile remove" defaults force to false', async () => {
  const s = spy();
  await main(['profile', 'remove', '--profile', 'newbie'], {
    commands: { profile: s.make('profile') },
  });
  assert.deepEqual(s.calls, [
    ['profile', { action: 'remove', profile: 'newbie', force: false }],
  ]);
});

test('main: "setup" dispatches with just the profile', async () => {
  const s = spy();
  const code = await main(['setup', '--profile', 'rajni'], {
    commands: { setup: s.make('setup') },
  });
  assert.equal(code, 0);
  assert.deepEqual(s.calls, [['setup', { profile: 'rajni' }]]);
});

test('main: "migrate" dispatches with profile and apply defaulting to false', async () => {
  const s = spy();
  const code = await main(['migrate', '--profile', 'rajni'], {
    commands: { migrate: s.make('migrate') },
  });
  assert.equal(code, 0);
  assert.deepEqual(s.calls, [['migrate', { profile: 'rajni', apply: false }]]);
});

test('main: "migrate --apply" carries apply through', async () => {
  const s = spy();
  const code = await main(['migrate', '--profile', 'rajni', '--apply'], {
    commands: { migrate: s.make('migrate') },
  });
  assert.equal(code, 0);
  assert.deepEqual(s.calls, [['migrate', { profile: 'rajni', apply: true }]]);
});

test('main: "migrate" without --profile returns 2', async () => {
  const code = await main(['migrate'], {
    commands: { migrate: async () => 0 },
    stderr: () => {},
  });
  assert.equal(code, 2);
});

test('main: the usage line names every dispatchable command', async () => {
  const stderr = captureStderr();
  await main(['bogus'], { stderr: stderr.write });
  const usage = stderr.lines.join(' ');
  for (const name of [
    'run',
    'doctor',
    'reconcile',
    'stage',
    'routine',
    'serve',
    'autostart',
    'lane',
    'profile',
    'setup',
    'release',
    'migrate',
  ]) {
    assert.match(usage, new RegExp(name), `usage should mention "${name}"`);
  }
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

test('main: release refuses when npm swallowed the safety flags (no -- separator)', async () => {
  let called = false;
  const stderr = captureStderr();
  const code = await main(['release', '1.3.0'], {
    commands: {
      release: (async () => {
        called = true;
        return 0;
      }) as CommandFn,
    },
    stderr: stderr.write,
    env: { npm_lifecycle_event: 'release', npm_config_dry_run: 'true' },
  });
  assert.equal(code, 2);
  assert.equal(called, false, 'release must not run with silently-dropped flags');
  assert.match(stderr.lines.join('\n'), /--/);
});

test('main: release dispatches normally when run via npm with a -- separator', async () => {
  let received: unknown;
  const code = await main(['release', '1.3.0', '--dry-run'], {
    commands: {
      release: (async (opts) => {
        received = opts;
        return 0;
      }) as CommandFn,
    },
    env: { npm_lifecycle_event: 'release' },
  });
  assert.equal(code, 0);
  assert.deepEqual(received, {
    version: '1.3.0',
    dryRun: true,
    noMerge: false,
    yes: false,
  });
});

test('main: prints the daemon-liveness warning, first, when one is returned', async () => {
  const stderr = captureStderr();
  const code = await main(['doctor', '--profile', 'rajni'], {
    commands: { doctor: async () => 0 },
    stderr: stderr.write,
    checkDaemonLiveness: () =>
      'warning: jobbunny daemon appears wedged (no tick in over 5 minutes)',
  });
  assert.equal(code, 0);
  assert.ok(stderr.lines[0]?.includes('appears wedged'));
});

test('main: prints nothing when checkDaemonLiveness returns undefined', async () => {
  const stderr = captureStderr();
  const code = await main(['doctor', '--profile', 'rajni'], {
    commands: { doctor: async () => 0 },
    stderr: stderr.write,
    checkDaemonLiveness: () => undefined,
  });
  assert.equal(code, 0);
  assert.deepEqual(stderr.lines, []);
});
