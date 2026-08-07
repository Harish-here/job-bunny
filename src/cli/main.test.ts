/**
 * main.test.ts (P8) — TDD for the `main` dispatcher: argv parsing +
 * command dispatch only. Every command is a FAKE injected via `MainDeps`;
 * no real `run`/`doctor` command (and therefore no `wire`/adapters) is
 * exercised here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { USAGE } from './args.ts';
import { type CommandFn, defaultCheckHome, HOME_EXEMPT_COMMANDS, main } from './main.ts';

// The dispatch tests below exercise command routing only (every command is
// a FAKE — see the module doc comment) and don't care whether a data home
// exists. Anchoring JOBBUNNY_HOME at the checkout itself keeps the default
// missing-home check (`defaultCheckHome`, exercised by `deps.homeCheck`'s
// default) from tripping in a fresh environment (CI, a new contributor's
// machine) where `~/.jobbunny` does not exist yet — a checkout is a valid
// home by design (its layout is identical to a home's; see CLAUDE.md's
// data-home paragraph). Tests that specifically exercise the home check
// inject their own `homeCheck` and are unaffected by this. `node --test`
// runs each matched file in its own process, so this does not leak into
// other test files.
process.env.JOBBUNNY_HOME = process.cwd();

function captureStderr(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s: string) => lines.push(s) };
}

function captureStdout(): { lines: string[]; write: (s: string) => void } {
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

test('main: "board" dispatches profile-less, parsing --port to a number', async () => {
  const s = spy();
  const noPort = await main(['board'], { commands: { board: s.make('board') } });
  const withPort = await main(['board', '--port', '0'], {
    commands: { board: s.make('board') },
  });
  assert.equal(noPort, 0);
  assert.equal(withPort, 0);
  assert.deepEqual(s.calls, [
    ['board', {}],
    ['board', { port: 0 }],
  ]);
});

test('main: a non-numeric --port for "board" returns 2', async () => {
  const stderr = captureStderr();
  const code = await main(['board', '--port', 'abc'], {
    commands: { board: async () => 0 },
    stderr: stderr.write,
  });
  assert.equal(code, 2);
  assert.match(stderr.lines.join('\n'), /board: --port must be a non-negative integer/);
});

test('main: a negative --port for "board" returns 2', async () => {
  const stderr = captureStderr();
  const code = await main(['board', '--port=-1'], {
    commands: { board: async () => 0 },
    stderr: stderr.write,
  });
  assert.equal(code, 2);
  assert.match(stderr.lines.join('\n'), /board: --port must be a non-negative integer/);
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

// --- --help / -h (P8 data-home Task 3) ---

test('main: --help prints USAGE on stdout and exits 0', async () => {
  const stdout = captureStdout();
  const code = await main(['--help'], { stdout: stdout.write });
  assert.equal(code, 0);
  assert.equal(stdout.lines.join('\n'), USAGE);
});

test('main: -h behaves like --help and needs no data home', async () => {
  const stdout = captureStdout();
  const stderr = captureStderr();
  const code = await main(['-h'], {
    stdout: stdout.write,
    stderr: stderr.write,
    homeCheck: () => "no jobbunny home at /nope/.jobbunny — run 'jobbunny setup'",
  });
  assert.equal(code, 0);
  assert.equal(stdout.lines.join('\n'), USAGE);
  assert.deepEqual(stderr.lines, []);
});

// --- Node guard + missing-home check (P8 data-home Task 3) ---

test('main: an old Node prints the one-line version guard and exits non-zero', async () => {
  const stderr = captureStderr();
  const code = await main(['doctor', '--profile', 'x'], {
    nodeVersion: '22.18.0',
    stderr: stderr.write,
  });
  assert.notEqual(code, 0);
  assert.deepEqual(stderr.lines, ['jobbunny needs Node >= 24 (found 22.18.0)']);
});

test('main: the version guard runs before anything else', async () => {
  let called = false;
  const stderr = captureStderr();
  await main(['doctor', '--profile', 'x'], {
    nodeVersion: '22.18.0',
    stderr: stderr.write,
    commands: {
      doctor: async () => {
        called = true;
        return 0;
      },
    },
  });
  assert.equal(called, false);
});

test('main: a missing home reports the friendly line and exits non-zero', async () => {
  const stderr = captureStderr();
  let called = false;
  const code = await main(['doctor', '--profile', 'x'], {
    homeCheck: () => "no jobbunny home at /nope/.jobbunny — run 'jobbunny setup'",
    stderr: stderr.write,
    commands: {
      doctor: async () => {
        called = true;
        return 0;
      },
    },
  });
  assert.deepEqual(stderr.lines, [
    "no jobbunny home at /nope/.jobbunny — run 'jobbunny setup'",
  ]);
  assert.notEqual(code, 0);
  assert.equal(called, false);
});

test('main: setup and migrate-home are exempt from the missing-home check', async () => {
  const exempt = new Set(['setup', 'migrate-home', 'release']);
  const homeCheck = (command: string) =>
    exempt.has(command)
      ? undefined
      : "no jobbunny home at /nope/.jobbunny — run 'jobbunny setup'";
  const s = spy();
  const code = await main(['setup', '--profile', 'x'], {
    homeCheck,
    commands: { setup: s.make('setup') },
  });
  assert.equal(code, 0);
  assert.deepEqual(s.calls, [['setup', { profile: 'x' }]]);
});

// --- defaultCheckHome / HOME_EXEMPT_COMMANDS (fix round) ---
// Direct coverage of main.ts's own default `homeCheck` implementation —
// the tests above only prove `main()` forwards a command name to whatever
// `homeCheck` it's given, never this function's own exemption set,
// `existsSync` probe, or the exact frozen message string. `env`/
// `existsSyncFn` are injected here so none of this depends on the ambient
// `JOBBUNNY_HOME` this file sets at module load (line 23) or on any real
// filesystem state.

test('defaultCheckHome: setup, migrate-home, and release are exempt — undefined regardless of whether the home exists', () => {
  const neverExists = () => false;
  assert.equal(defaultCheckHome('setup', { existsSyncFn: neverExists }), undefined);
  assert.equal(
    defaultCheckHome('migrate-home', { existsSyncFn: neverExists }),
    undefined,
  );
  assert.equal(defaultCheckHome('release', { existsSyncFn: neverExists }), undefined);
});

test('defaultCheckHome: HOME_EXEMPT_COMMANDS names exactly setup, migrate-home, release', () => {
  assert.deepEqual(
    [...HOME_EXEMPT_COMMANDS].sort(),
    ['migrate-home', 'release', 'setup'].sort(),
  );
});

test('defaultCheckHome: a non-exempt command against a non-existent home returns the exact frozen message', () => {
  const detail = defaultCheckHome('doctor', {
    env: { JOBBUNNY_HOME: '/nope/.jobbunny' },
    existsSyncFn: () => false,
  });
  assert.equal(detail, "no jobbunny home at /nope/.jobbunny — run 'jobbunny setup'");
});

test('defaultCheckHome: a non-exempt command against an EXISTING home returns undefined', () => {
  const detail = defaultCheckHome('doctor', {
    env: { JOBBUNNY_HOME: '/exists/.jobbunny' },
    existsSyncFn: (p) => p === '/exists/.jobbunny',
  });
  assert.equal(detail, undefined);
});
