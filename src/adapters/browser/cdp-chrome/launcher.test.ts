import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildLaunchArgv,
  CHROME_MAX_AGE_MS,
  CHROME_PATH_CANDIDATES,
  getProcessAgeMs,
  killChrome,
  launchChrome,
  parseEtimeToMs,
  resolveChromePath,
  resolveListenerPid,
} from './launcher.ts';

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

test('killChrome sends SIGTERM to the spawned pid by default', async () => {
  const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const result = await killChrome(4242, {
    env: {},
    kill: (pid, signal) => {
      calls.push({ pid, signal });
    },
    isAlive: () => false,
    sleep: instantSleep,
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
