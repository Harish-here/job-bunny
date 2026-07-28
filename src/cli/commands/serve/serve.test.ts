import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DaemonPidfileDeps } from '../../../ops/daemon/index.ts';
import {
  acquireDaemonPidfile,
  HEARTBEAT_STALE_MS,
  readDaemonPidfile,
  updateDaemonPidfile,
} from '../../../ops/daemon/index.ts';
import type { LogDeps } from '../../../ops/daemon/logs/index.ts';
import type { ScanDeps } from '../../../ops/daemon/scan/index.ts';
import type { ServeDeps, SpawnFn, SpawnHandle } from './index.ts';
import { serveCommand } from './index.ts';

const ROOT = '/fake/root';
const HOME = '/fake/home';
const PROFILES_DIR = '/fake/profiles';

/** The scan helpers compose paths with `node:path.join`, so an expectation
 * spelled as a POSIX literal fails on windows-latest. */
function profilePath(name: string): string {
  return join(PROFILES_DIR, name, 'profile.json');
}

function fakePidfileDeps(): DaemonPidfileDeps {
  const files = new Map<string, string>();
  const notFound = (): never => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
  return {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => files.get(p) ?? notFound(),
    writeFileSync: (p, data) => {
      files.set(p, data);
    },
    writeFileSyncExclusive: (p, data) => {
      if (files.has(p)) return false;
      files.set(p, data);
      return true;
    },
    renameSync: (from, to) => {
      const content = files.get(from) ?? notFound();
      files.delete(from);
      files.set(to, content);
    },
    unlinkSync: (p) => {
      files.delete(p);
    },
    pidIsAlive: () => true,
    now: () => new Date(),
  };
}

function fakeLogDeps(): LogDeps {
  return {
    existsSync: () => true,
    mkdirSync: () => {},
    statSync: () => ({ size: 0 }),
    renameSync: () => {},
    openSync: () => 42,
    closeSync: () => {},
  };
}

function fakeScanDeps(): ScanDeps {
  return {
    existsSync: () => false,
    readdirSync: () => [],
    readFileSync: () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    },
  };
}

function fakeChildHandle(pid: number | undefined): {
  handle: SpawnHandle;
  emit(event: string, arg?: unknown): void;
  killCalls: string[];
} {
  const listeners = new Map<string, Array<(arg: unknown) => void>>();
  const killCalls: string[] = [];
  const handle: SpawnHandle = {
    pid,
    on(event, cb) {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
    },
    kill(signal) {
      killCalls.push(signal);
      return true;
    },
    unref() {},
  };
  return {
    handle,
    emit(event, arg) {
      for (const cb of listeners.get(event) ?? []) cb(arg);
    },
    killCalls,
  };
}

function baseServeDeps(overrides: Partial<ServeDeps> = {}): {
  deps: ServeDeps;
  writes: string[];
  errs: string[];
  sleeps: number[];
} {
  const writes: string[] = [];
  const errs: string[] = [];
  const sleeps: number[] = [];
  const child = fakeChildHandle(9001);
  const spawn: SpawnFn = () => child.handle;
  const deps: ServeDeps = {
    root: ROOT,
    home: HOME,
    platform: 'darwin',
    uid: 501,
    pid: 100,
    profilesDir: PROFILES_DIR,
    pidfile: fakePidfileDeps(),
    logs: fakeLogDeps(),
    scan: fakeScanDeps(),
    listLaunchAgentFiles: () => [],
    spawn,
    nodeBin: 'node',
    cliEntry: 'src/cli/main.ts',
    pidIsAlive: () => true,
    killPid: () => {},
    now: () => new Date(2026, 6, 27, 14, 4),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    readDaemonLogTail: () => '(log tail)',
    write: (line) => writes.push(line),
    writeErr: (line) => errs.push(line),
    ...overrides,
  };
  return { deps, writes, errs, sleeps };
}

test('start: refuses when a legacy launchd plist is found, and prints a cleanup block', async () => {
  const { deps, errs } = baseServeDeps({
    listLaunchAgentFiles: () => [
      'com.jobbunny.0900.plist',
      'com.jobbunny.autostart.plist',
    ],
  });
  const code = await serveCommand({ action: 'start' }, deps);
  assert.equal(code, 1);
  const printed = errs.join('\n');
  assert.match(printed, /com\.jobbunny\.0900/);
  assert.doesNotMatch(printed, /com\.jobbunny\.autostart/);
  assert.match(printed, /launchctl bootout gui\/501\/com\.jobbunny\.0900/);
});

test('start: an autostart-only LaunchAgents dir does not trigger the migration refusal', async () => {
  const { deps } = baseServeDeps({
    listLaunchAgentFiles: () => ['com.jobbunny.autostart.plist'],
  });
  const code = await serveCommand({ action: 'start' }, deps);
  assert.equal(code, 0);
});

test('start: acquisition failure against a live, fresh daemon exits nonzero without stealing', async () => {
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile(ROOT, 999, pidfile); // a fresh, live "other" daemon.
  const { deps, sleeps } = baseServeDeps({ pidfile, pidIsAlive: () => true });
  const code = await serveCommand({ action: 'start' }, deps);
  assert.equal(code, 1);
  assert.equal(readDaemonPidfile(ROOT, pidfile)?.pid, 999); // untouched.
  assert.deepEqual(sleeps, []); // no steal attempt, no re-check wait.
});

test('start: a dead pid steals immediately — no 35s re-check wait', async () => {
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile(ROOT, 999, pidfile); // the "other" daemon's placeholder.
  // B3: staleness is decided by isDaemonPidfileStale(existing,
  // deps.pidfile) inside runServeStartParent — the PIDFILE deps' OWN
  // pidIsAlive, not ServeDeps.pidIsAlive (a separate, later check). Both
  // must agree pid 999 is dead, or the code takes the "still running,
  // refuse" branch before ever reaching the steal path.
  pidfile.pidIsAlive = (pid) => pid !== 999;
  const { deps, sleeps } = baseServeDeps({
    pidfile,
    pidIsAlive: (pid) => pid !== 999, // 999 is dead; the spawned child (9001) is alive.
  });
  const code = await serveCommand({ action: 'start' }, deps);
  assert.equal(code, 0);
  // F8: the parent re-acquires under its OWN pid and never overwrites the
  // field afterwards — the spawned child claims it as its first action
  // (see runServeStartChild), so the parent-side race is gone.
  assert.equal(readDaemonPidfile(ROOT, pidfile)?.pid, deps.pid); // stolen and re-recorded.
  assert.ok(!sleeps.includes(35_000)); // no re-check wait for a dead pid.
});

test('start: a stale heartbeat on a LIVE pid is re-checked after 35s and refused when it advanced', async () => {
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile(ROOT, 999, pidfile);
  // Stale by the heartbeat rule, but pid 999 is ALIVE (the pidfile fake's
  // own pidIsAlive says so, and B3 requires ServeDeps.pidIsAlive to agree)
  // — exactly the shape a machine that just woke from sleep presents, and
  // the one case that must NOT be stolen on first observation.
  const staleTick = new Date(Date.now() - HEARTBEAT_STALE_MS - 60_000).toISOString();
  updateDaemonPidfile(ROOT, (c) => ({ ...c, lastTickAt: staleTick }), pidfile);

  const observedSleeps: number[] = [];
  const { deps } = baseServeDeps({
    pidfile,
    pidIsAlive: () => true,
    sleep: async (ms) => {
      observedSleeps.push(ms);
      // The other daemon wakes mid-wait and heartbeats — the re-check must
      // see lastTickAt advance and back off rather than steal a live daemon.
      if (ms === 35_000) {
        updateDaemonPidfile(
          ROOT,
          (c) => ({ ...c, lastTickAt: new Date().toISOString() }),
          pidfile,
        );
      }
    },
  });

  const code = await serveCommand({ action: 'start' }, deps);
  assert.equal(code, 1);
  assert.ok(observedSleeps.includes(35_000)); // the re-check wait happened.
  const after = readDaemonPidfile(ROOT, pidfile);
  assert.equal(after?.pid, 999); // untouched — never stolen, never re-acquired.
  assert.notEqual(after?.lastTickAt, staleTick); // it really was the woken daemon.
});

test('stop: kills the daemon before the in-flight child, re-reading the pidfile between them', async () => {
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile(ROOT, 1000, pidfile);
  updateDaemonPidfile(
    ROOT,
    (c) => ({
      ...c,
      inFlight: { pid: 2000, profile: 'harish', startedAt: pidfile.now().toISOString() },
    }),
    pidfile,
  );
  const killOrder: string[] = [];
  const alive = new Set([1000, 2000]);
  const { deps } = baseServeDeps({
    pidfile,
    pidIsAlive: (pid) => alive.has(pid),
    killPid: (pid, signal) => {
      killOrder.push(`${pid}:${signal}`);
      if (signal === 'SIGTERM') alive.delete(pid); // dies promptly on SIGTERM.
    },
  });
  const code = await serveCommand({ action: 'stop' }, deps);
  assert.equal(code, 0);
  assert.deepEqual(killOrder, ['1000:SIGTERM', '2000:SIGTERM']); // daemon, then child.
  assert.equal(readDaemonPidfile(ROOT, pidfile), undefined); // pidfile removed.
});

test('stop: exits nonzero and leaves the pidfile when the daemon survives SIGKILL', async () => {
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile(ROOT, 1000, pidfile);
  const { deps, errs } = baseServeDeps({
    pidfile,
    pidIsAlive: () => true, // never dies, however hard we try.
  });
  const code = await serveCommand({ action: 'stop' }, deps);
  assert.equal(code, 1);
  assert.ok(errs.some((e) => e.includes('survived SIGKILL')));
  assert.notEqual(readDaemonPidfile(ROOT, pidfile), undefined); // left in place.
});

test('stop: the pidfile still contains inFlight after the daemon process has already exited, and stop kills that pid (B1)', async () => {
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile(ROOT, 1000, pidfile);
  updateDaemonPidfile(
    ROOT,
    (c) => ({
      ...c,
      inFlight: { pid: 4000, profile: 'harish', startedAt: pidfile.now().toISOString() },
    }),
    pidfile,
  );
  // Simulates the daemon having already exited (crashed, or its own
  // SIGTERM shutdown handler already ran) WITHOUT releasing the
  // pidfile — per B1, release belongs exclusively to `serve stop`. Only
  // the in-flight child (4000) is alive; the daemon (1000) is already
  // dead, so `stop` must still find and kill the surviving child from
  // the persisted file rather than short-circuit on "no pidfile found".
  const alive = new Set([4000]);
  const killOrder: string[] = [];
  const { deps } = baseServeDeps({
    pidfile,
    pidIsAlive: (pid) => alive.has(pid),
    killPid: (pid, signal) => {
      killOrder.push(`${pid}:${signal}`);
      if (signal === 'SIGTERM') alive.delete(pid);
    },
  });
  assert.equal(readDaemonPidfile(ROOT, pidfile)?.inFlight?.pid, 4000); // still present pre-stop.
  const code = await serveCommand({ action: 'stop' }, deps);
  assert.equal(code, 0);
  assert.ok(killOrder.includes('4000:SIGTERM')); // the in-flight child was found and killed.
  assert.equal(readDaemonPidfile(ROOT, pidfile), undefined);
});

test('status: renders pid/uptime, last-tick, in-flight (profile + elapsed), and next-fire lines', async () => {
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile(ROOT, 1000, pidfile);
  updateDaemonPidfile(
    ROOT,
    (c) => ({
      ...c,
      inFlight: {
        pid: 3000,
        profile: 'harish',
        startedAt: new Date(2026, 6, 27, 14, 0).toISOString(),
      },
      lastTickAt: new Date(2026, 6, 27, 14, 3).toISOString(),
    }),
    pidfile,
  );
  const scan: ScanDeps = {
    // Both the profiles dir AND harish's profile.json must report as
    // existing: scanProfileSchedules (Task 5) gates its readFileSync on
    // existsSync('<profilesDir>/<name>/profile.json'), so a fake that
    // only acknowledges the directory yields zero schedules and the
    // next-fire line below would silently read "none scheduled".
    existsSync: (p) => p === PROFILES_DIR || p === profilePath('harish'),
    readdirSync: (p) => (p === PROFILES_DIR ? ['harish'] : []),
    readFileSync: (p) =>
      p === profilePath('harish')
        ? JSON.stringify({
            connector: 'notion',
            schedule: {
              times: ['16:30'],
              enabled: true,
              weekdays: [1, 2, 3, 4, 5],
              graceMinutes: 90,
            },
          })
        : (() => {
            const err = new Error('ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            throw err;
          })(),
  };
  const { deps, writes } = baseServeDeps({ pidfile, scan });
  const code = await serveCommand({ action: 'status' }, deps);
  assert.equal(code, 0);
  const printed = writes.join('\n');
  assert.match(printed, /running \(pid 1000, uptime/);
  assert.match(printed, /last tick:/);
  assert.match(printed, /in flight: pid 3000 \(profile harish, running/); // C1: profile + elapsed, not just a pid.
  assert.match(printed, /next fire:.*harish/);
});

test('status: an unparseable lastTickAt reports "age unknown" and wedged, never NaN', async () => {
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile(ROOT, 1000, pidfile);
  updateDaemonPidfile(ROOT, (c) => ({ ...c, lastTickAt: 'not-a-date' }), pidfile);

  const { deps, writes } = baseServeDeps({ pidfile });
  const code = await serveCommand({ action: 'status' }, deps);
  assert.equal(code, 0);
  const printed = writes.join('\n');
  assert.match(printed, /last tick: not-a-date \(age unknown\) — appears wedged/);
  assert.doesNotMatch(printed, /NaN/);
});
