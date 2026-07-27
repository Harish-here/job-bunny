import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildLaunchArgv,
  CHROME_MAX_AGE_MS,
  CHROME_PATH_CANDIDATES,
  clearSessionState,
  getProcessAgeMs,
  killChrome,
  launchChrome,
  parseEtimeToMs,
  resolveChromePath,
  resolveListenerPid,
  SESSION_CLEAR_PROFILE_DIR,
  SESSION_CLEAR_SKIP_ENV,
} from './launcher.ts';
import type { ChromePidfile, ChromePidfileDeps } from './ownership/index.ts';

/** Real fs, pointed only at a throwaway temp dir this file creates and
 * removes — clearSessionState's own tests deliberately exercise the real
 * implementation (not mocked fs calls) so the auth-preservation guarantee
 * is proven against actual files, never against `.chrome-debug/` itself. */
const realFsDeps = { existsSync, rmSync, readFileSync, writeFileSync };

/** Builds `<tmp>/Default/...` with a Sessions dir, a Preferences file, and
 * a handful of auth-bearing files/dirs — the same shape confirmed on disk
 * under the real `.chrome-debug/Default/` (2026-07-25). */
function makeProfileFixture(): { userDataDir: string; profileDir: string } {
  const userDataDir = mkdtempSync(join(tmpdir(), 'jobbunny-chrome-fixture-'));
  const profileDir = join(userDataDir, SESSION_CLEAR_PROFILE_DIR);
  mkdirSync(profileDir, { recursive: true });

  // Session/tab state — expected to be cleared.
  const sessionsDir = join(profileDir, 'Sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, 'Session_123'), 'fake-session-bytes');
  writeFileSync(join(sessionsDir, 'Tabs_123'), 'fake-tabs-bytes');

  writeFileSync(
    join(profileDir, 'Preferences'),
    JSON.stringify({
      profile: {
        exit_type: 'Crashed',
        name: 'Person 1',
        unrelated_nested: { deeply: { nested: [1, 2, 3], flag: true } },
      },
      some_other_top_level_key: { untouched: true },
    }),
    'utf8',
  );

  // Auth-bearing state — MUST survive untouched.
  writeFileSync(join(profileDir, 'Cookies'), 'fake-cookie-db-bytes');
  writeFileSync(join(profileDir, 'Login Data'), 'fake-login-data-bytes');
  const localStorageDir = join(profileDir, 'Local Storage');
  mkdirSync(localStorageDir, { recursive: true });
  writeFileSync(join(localStorageDir, 'leveldb-file.ldb'), 'fake-local-storage-bytes');

  return { userDataDir, profileDir };
}

/** No real delay — every killChrome escalation test injects this so the
 * SIGTERM-wait-SIGKILL loop resolves near-instantly instead of taking
 * graceMs of real wall-clock time. */
const instantSleep = async () => {};

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
    /no Chrome executable found \(checked: \/a, \/b\) — install Google Chrome \(or Microsoft Edge on Windows\)/,
  );
});

test('buildLaunchArgv sets --remote-debugging-port, --user-data-dir, and the session-restore-suppression flags', () => {
  const argv = buildLaunchArgv({ port: 9222, userDataDir: '/repo/.chrome-debug' });
  assert.deepEqual(argv, [
    '--remote-debugging-port=9222',
    '--user-data-dir=/repo/.chrome-debug',
    '--restore-last-session=false',
    '--no-first-run',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
  ]);
});

test('buildLaunchArgv never adds a flag that would destroy auth state (cookies/storage/profile/incognito)', () => {
  const argv = buildLaunchArgv({ port: 9222, userDataDir: '/repo/.chrome-debug' });
  const authDestroyingPatterns = [
    /incognito/i,
    /guest/i,
    /disable-application-cache/i,
    /clear-token-service/i,
    /disk-cache-dir/i,
    /--user-data-dir=(?!\/repo\/\.chrome-debug$)/i, // must be the real profile, not a throwaway
  ];
  for (const flag of argv) {
    for (const pattern of authDestroyingPatterns) {
      assert.ok(
        !pattern.test(flag),
        `flag "${flag}" looks auth-destroying (matched ${pattern})`,
      );
    }
  }
  // The real user-data-dir must still be present, untouched.
  assert.ok(argv.includes('--user-data-dir=/repo/.chrome-debug'));
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
      pidfileDeps: fakePidfileDepsForLauncher().deps,
    },
  );
  assert.equal(proc.pid, 4242);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]?.command, '/only/chrome');
  assert.deepEqual(spawnCalls[0]?.args, [
    '--remote-debugging-port=9333',
    '--user-data-dir=/repo/.chrome-debug',
    '--restore-last-session=false',
    '--no-first-run',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
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
      pidfileDeps: fakePidfileDepsForLauncher().deps,
    },
  );
  assert.equal(unrefCalled, true);
});

test('launchChrome propagates the resolveChromePath error when no candidate exists', () => {
  assert.throws(
    () =>
      launchChrome(
        { port: 9222, candidates: ['/nope'] },
        {
          existsSync: () => false,
          spawn: () => ({ pid: 1, unref: () => {} }),
          pidfileDeps: fakePidfileDepsForLauncher().deps,
        },
      ),
    /no Chrome executable found/,
  );
});

test('launchChrome resolves via JOBBUNNY_CHROME_PATH when set, ignoring the candidates option entirely', () => {
  const spawnCalls: Array<{ command: string }> = [];
  const proc = launchChrome(
    { port: 9222, candidates: ['/configured/chrome'] },
    {
      existsSync: (path) => path === '/from/env/chrome',
      spawn: (command) => {
        spawnCalls.push({ command });
        return { pid: 4242, unref: () => {} };
      },
      env: { JOBBUNNY_CHROME_PATH: '/from/env/chrome' },
      pidfileDeps: fakePidfileDepsForLauncher().deps,
    },
  );
  assert.equal(proc.pid, 4242);
  assert.equal(spawnCalls[0]?.command, '/from/env/chrome');
});

test('killChrome sends SIGTERM to the spawned pid by default', async () => {
  const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const result = await killChrome(4242, {
    env: {},
    kill: (pid, signal) => {
      calls.push({ pid, signal });
    },
    isAlive: () => false,
    sleep: instantSleep,
    pidfileDeps: fakePidfileDepsForLauncher().deps,
  });
  assert.equal(result, true);
  assert.deepEqual(calls, [{ pid: 4242, signal: 'SIGTERM' }]);
});

test('killChrome does nothing when JOBBUNNY_KEEP_BROWSER=1', async () => {
  const calls: number[] = [];
  const result = await killChrome(4242, {
    env: { JOBBUNNY_KEEP_BROWSER: '1' },
    kill: (pid) => {
      calls.push(pid);
    },
    pidfileDeps: fakePidfileDepsForLauncher().deps,
  });
  assert.equal(result, false);
  assert.deepEqual(calls, []);
});

test('killChrome is a no-op when there is no pid to kill', async () => {
  const calls: number[] = [];
  const result = await killChrome(undefined, {
    env: {},
    kill: (pid) => {
      calls.push(pid);
    },
    pidfileDeps: fakePidfileDepsForLauncher().deps,
  });
  assert.equal(result, false);
  assert.deepEqual(calls, []);
});

test('killChrome treats an already-gone process as a handled no-op, not a throw', async () => {
  const result = await killChrome(4242, {
    env: {},
    kill: () => {
      throw new Error('ESRCH');
    },
    pidfileDeps: fakePidfileDepsForLauncher().deps,
  });
  assert.equal(result, false);
});

test('killChrome resolves without escalating when the process exits after SIGTERM', async () => {
  const signals: NodeJS.Signals[] = [];
  let aliveChecks = 0;
  const result = await killChrome(4242, {
    env: {},
    kill: (_pid, signal) => {
      signals.push(signal);
    },
    isAlive: () => {
      aliveChecks += 1;
      // "dies" on the second poll — SIGTERM took effect, no SIGKILL needed.
      return aliveChecks < 2;
    },
    sleep: instantSleep,
    pollIntervalMs: 250,
    graceMs: 5000,
    pidfileDeps: fakePidfileDepsForLauncher().deps,
  });

  assert.equal(result, true);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('killChrome escalates to SIGKILL when the process is still alive after the SIGTERM grace period', async () => {
  // Real (but tiny) timers here rather than a faked sleep: the escalation
  // decision hinges on wall-clock deadline expiry (Date.now() vs
  // start+graceMs), so a zero-delay fake sleep would spin the poll loop
  // indefinitely fast instead of ever crossing the deadline. Small real ms
  // values keep this deterministic AND fast (well under 100ms).
  const signals: NodeJS.Signals[] = [];
  const start = Date.now();
  const result = await killChrome(4242, {
    env: {},
    kill: (_pid, signal) => {
      signals.push(signal);
    },
    isAlive: () => true, // wedged — never exits on its own
    pollIntervalMs: 5,
    graceMs: 20,
    settleMs: 5,
    pidfileDeps: fakePidfileDepsForLauncher().deps,
  });
  const elapsed = Date.now() - start;

  assert.equal(result, true);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(elapsed < 500, `expected escalation to finish quickly, took ${elapsed}ms`);
});

test('killChrome does not throw if SIGKILL races an already-exited process', async () => {
  const result = await killChrome(4242, {
    env: {},
    kill: (_pid, signal) => {
      if (signal === 'SIGKILL') throw new Error('ESRCH');
    },
    isAlive: () => true,
    graceMs: 10,
    pollIntervalMs: 5,
    settleMs: 1,
    pidfileDeps: fakePidfileDepsForLauncher().deps,
  });
  assert.equal(result, true);
});

test('resolveListenerPid returns the pid lsof reports listening on the port', () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const pid = resolveListenerPid(9222, {
    execFileSync: (command, args) => {
      calls.push({ command, args });
      return '54321\n';
    },
  });
  assert.equal(pid, 54321);
  assert.deepEqual(calls, [{ command: 'lsof', args: ['-ti', ':9222', '-sTCP:LISTEN'] }]);
});

test('resolveListenerPid returns undefined when nothing is listening (lsof throws)', () => {
  const pid = resolveListenerPid(9222, {
    execFileSync: () => {
      throw new Error('lsof: no matches');
    },
  });
  assert.equal(pid, undefined);
});

test('resolveListenerPid returns undefined on blank lsof output', () => {
  const pid = resolveListenerPid(9222, { execFileSync: () => '' });
  assert.equal(pid, undefined);
});

test('parseEtimeToMs parses MM:SS', () => {
  assert.equal(parseEtimeToMs('05:30'), (5 * 60 + 30) * 1000);
});

test('parseEtimeToMs parses HH:MM:SS', () => {
  assert.equal(parseEtimeToMs('02:15:00'), (2 * 3600 + 15 * 60) * 1000);
});

test('parseEtimeToMs parses DD-HH:MM:SS', () => {
  assert.equal(parseEtimeToMs('1-00:00:00'), 24 * 3600 * 1000);
});

test('parseEtimeToMs parses bare SS', () => {
  assert.equal(parseEtimeToMs('45'), 45 * 1000);
});

test('getProcessAgeMs converts ps etime output to milliseconds', () => {
  const ageMs = getProcessAgeMs(4242, {
    execFileSync: () => ' 25:03:12 \n',
  });
  assert.equal(ageMs, (25 * 3600 + 3 * 60 + 12) * 1000);
});

test('getProcessAgeMs returns null when the pid cannot be inspected', () => {
  const ageMs = getProcessAgeMs(4242, {
    execFileSync: () => {
      throw new Error('ps: no such process');
    },
  });
  assert.equal(ageMs, null);
});

test('CHROME_MAX_AGE_MS is 24 hours', () => {
  assert.equal(CHROME_MAX_AGE_MS, 24 * 60 * 60 * 1000);
});

test('clearSessionState removes Sessions/tab-restore files from a temp fixture', () => {
  const { userDataDir, profileDir } = makeProfileFixture();
  try {
    const result = clearSessionState(userDataDir, realFsDeps);
    assert.equal(result.attempted, true);
    assert.ok(result.removedEntries.includes('Sessions'));
    assert.equal(existsSync(join(profileDir, 'Sessions')), false);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('clearSessionState normalizes Preferences exit_type/exited_cleanly while preserving every other key byte-for-byte', () => {
  const { userDataDir, profileDir } = makeProfileFixture();
  try {
    const before = JSON.parse(readFileSync(join(profileDir, 'Preferences'), 'utf8'));
    const result = clearSessionState(userDataDir, realFsDeps);
    assert.equal(result.preferencesNormalized, true);

    const after = JSON.parse(readFileSync(join(profileDir, 'Preferences'), 'utf8'));
    assert.equal(after.profile.exit_type, 'Normal');
    assert.equal(after.profile.exited_cleanly, true);

    // Everything else — including deeply nested unrelated keys and
    // sibling top-level keys — must be untouched.
    assert.equal(after.profile.name, before.profile.name);
    assert.deepEqual(after.profile.unrelated_nested, before.profile.unrelated_nested);
    assert.deepEqual(after.some_other_top_level_key, before.some_other_top_level_key);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('clearSessionState never touches auth-bearing files (Cookies, Login Data, Local Storage/)', () => {
  const { userDataDir, profileDir } = makeProfileFixture();
  try {
    const cookiesBefore = readFileSync(join(profileDir, 'Cookies'), 'utf8');
    const loginDataBefore = readFileSync(join(profileDir, 'Login Data'), 'utf8');
    const localStorageFile = join(profileDir, 'Local Storage', 'leveldb-file.ldb');
    const localStorageBefore = readFileSync(localStorageFile, 'utf8');

    clearSessionState(userDataDir, realFsDeps);

    assert.equal(existsSync(join(profileDir, 'Cookies')), true);
    assert.equal(readFileSync(join(profileDir, 'Cookies'), 'utf8'), cookiesBefore);
    assert.equal(existsSync(join(profileDir, 'Login Data')), true);
    assert.equal(readFileSync(join(profileDir, 'Login Data'), 'utf8'), loginDataBefore);
    assert.equal(existsSync(localStorageFile), true);
    assert.equal(readFileSync(localStorageFile, 'utf8'), localStorageBefore);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('clearSessionState is a no-op (fail-soft) when the Sessions dir is missing', () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'jobbunny-chrome-fixture-'));
  try {
    mkdirSync(join(userDataDir, SESSION_CLEAR_PROFILE_DIR), { recursive: true });
    assert.doesNotThrow(() => clearSessionState(userDataDir, realFsDeps));
    const result = clearSessionState(userDataDir, realFsDeps);
    assert.equal(result.attempted, true);
    assert.deepEqual(result.removedEntries, []);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('clearSessionState is a no-op (fail-soft) when Preferences is malformed JSON', () => {
  const { userDataDir, profileDir } = makeProfileFixture();
  try {
    writeFileSync(join(profileDir, 'Preferences'), '{ not valid json', 'utf8');
    const result = clearSessionState(userDataDir, realFsDeps);
    assert.equal(result.preferencesNormalized, false);
    assert.ok(result.warnings.length > 0);
    // Left completely untouched, not rewritten.
    assert.equal(
      readFileSync(join(profileDir, 'Preferences'), 'utf8'),
      '{ not valid json',
    );
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('clearSessionState skips entirely when SingletonLock is present (Chrome already running)', () => {
  const { userDataDir, profileDir } = makeProfileFixture();
  try {
    writeFileSync(join(userDataDir, 'SingletonLock'), 'lock');
    const sessionsBefore = existsSync(join(profileDir, 'Sessions'));
    const result = clearSessionState(userDataDir, realFsDeps);
    assert.equal(result.attempted, false);
    assert.ok(result.warnings.some((w) => w.includes('SingletonLock')));
    // Nothing removed, Preferences untouched.
    assert.equal(existsSync(join(profileDir, 'Sessions')), sessionsBefore);
    assert.equal(result.preferencesNormalized, false);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('launchChrome runs the session clear before spawning (Sessions dir gone after launch)', () => {
  const { userDataDir, profileDir } = makeProfileFixture();
  try {
    launchChrome(
      { port: 9222, userDataDir, candidates: ['/only/chrome'] },
      {
        existsSync: (path) => path === '/only/chrome' || existsSync(path),
        spawn: () => ({ pid: 4242, unref: () => {} }),
        rmSync,
        readFileSync,
        writeFileSync,
        pidfileDeps: fakePidfileDepsForLauncher().deps,
      },
    );
    assert.equal(existsSync(join(profileDir, 'Sessions')), false);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('launchChrome skips the session clear when JOBBUNNY_SKIP_SESSION_CLEAR=1', () => {
  const { userDataDir, profileDir } = makeProfileFixture();
  try {
    launchChrome(
      { port: 9222, userDataDir, candidates: ['/only/chrome'] },
      {
        existsSync: (path) => path === '/only/chrome' || existsSync(path),
        spawn: () => ({ pid: 4242, unref: () => {} }),
        rmSync,
        readFileSync,
        writeFileSync,
        env: { [SESSION_CLEAR_SKIP_ENV]: '1' },
        pidfileDeps: fakePidfileDepsForLauncher().deps,
      },
    );
    assert.equal(existsSync(join(profileDir, 'Sessions')), true);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

function fakePidfileDepsForLauncher(): {
  deps: ChromePidfileDeps;
  written: ChromePidfile[];
  unlinked: number;
} {
  const written: ChromePidfile[] = [];
  let unlinked = 0;
  const deps: ChromePidfileDeps = {
    existsSync: () => written.length > 0,
    readFileSync: () => JSON.stringify(written[written.length - 1]),
    writeFileSync: (_path, data) => {
      written.push(JSON.parse(data) as ChromePidfile);
    },
    unlinkSync: () => {
      unlinked += 1;
    },
    pidIsAlive: () => true,
    now: () => new Date('2026-07-27T12:00:00.000Z'),
  };
  return { deps, written, unlinked };
}

test('launchChrome writes the Chrome pid file immediately after spawn returns a pid', () => {
  const { deps, written } = fakePidfileDepsForLauncher();
  launchChrome(
    { port: 9333, userDataDir: '/repo/.chrome-debug', candidates: ['/only/chrome'] },
    {
      existsSync: (path) => path === '/only/chrome',
      spawn: () => ({ pid: 4242, unref: () => {} }),
      pidfileDeps: deps,
    },
  );
  assert.equal(written.length, 1);
  assert.deepEqual(written[0], {
    pid: 4242,
    port: 9333,
    startedAt: '2026-07-27T12:00:00.000Z',
  });
});

test('killChrome clears the Chrome pid file once the process is confirmed dead', async () => {
  const { deps, written } = fakePidfileDepsForLauncher();
  written.push({ pid: 4242, port: 9222, startedAt: '2026-07-27T12:00:00.000Z' });
  let unlinked = 0;
  const clearingDeps: ChromePidfileDeps = {
    ...deps,
    unlinkSync: () => {
      unlinked += 1;
    },
  };
  await killChrome(4242, {
    env: {},
    kill: () => {},
    isAlive: () => false,
    sleep: instantSleep,
    pidfileDeps: clearingDeps,
  });
  assert.equal(unlinked, 1);
});

test('the session clear only ever runs via launchChrome, which provider.ts never calls on the reuse path', () => {
  // clearSessionState has exactly one caller: launchChrome (see this
  // module's doc comment). provider.ts's launch() only invokes
  // launchChromeFn on the 'launch' branch (or 'recycle' -> kill -> launch)
  // — never on 'reuse' or a recycle kept alive by recycleIfOld=false (see
  // provider.test.ts's "launch() reuses an already-reachable, fresh Chrome
  // instead of spawning", which asserts launchChromeFn.calls.length === 0
  // on that path). So a reuse/attach launch never touches session state:
  // the fake launchChrome injected there is a no-op stand-in that would
  // itself prove a call by incrementing a counter, and it never fires.
  // This test just pins that launchChrome (the one function that clears
  // session state) always runs the clear when it IS called — the "never
  // called on reuse" half of the contract is provider.test.ts's job, since
  // that's where the reuse-vs-launch decision actually lives.
  const { userDataDir, profileDir } = makeProfileFixture();
  try {
    let sessionsExistedBeforeSpawn: boolean | undefined;
    launchChrome(
      { port: 9222, userDataDir, candidates: ['/only/chrome'] },
      {
        existsSync: (path) => path === '/only/chrome' || existsSync(path),
        spawn: () => {
          sessionsExistedBeforeSpawn = existsSync(join(profileDir, 'Sessions'));
          return { pid: 4242, unref: () => {} };
        },
        rmSync,
        readFileSync,
        writeFileSync,
        pidfileDeps: fakePidfileDepsForLauncher().deps,
      },
    );
    // By the time spawn() runs, the clear has already happened.
    assert.equal(sessionsExistedBeforeSpawn, false);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
