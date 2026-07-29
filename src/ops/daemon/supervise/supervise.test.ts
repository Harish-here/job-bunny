import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { OwedRun } from '../../../core/schedule/index.ts';
import type { LogDeps } from '../logs/index.ts';
import type { DaemonPidfileDeps } from '../pidfile.ts';
import { acquireDaemonPidfile, readDaemonPidfile } from '../pidfile.ts';
import type { SuperviseDeps } from './supervise.ts';
import { BACKSTOP_MARGIN_MS, createSpawnRun, SIGKILL_GRACE_MS } from './supervise.ts';

const ROOT = '/fake/root';
const HOME = '/fake/home';
const RUNS_LOG_PATH = join(HOME, '.jobbunny', 'logs', 'runs.log');
const OWED: OwedRun = { profile: 'harish', date: '2026-07-27', slot: '14:00' };

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

function fakeChild(pid: number | undefined): {
  spawnArg: SuperviseDeps['spawn'];
  emit(event: string, arg?: unknown): void;
  killCalls: string[];
} {
  const listeners = new Map<string, Array<(arg: unknown) => void>>();
  const killCalls: string[] = [];
  const handle = {
    pid,
    on(event: string, cb: (arg: unknown) => void) {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
    },
    kill(signal: string) {
      killCalls.push(signal);
      return true;
    },
  };
  const spawnArg: SuperviseDeps['spawn'] = () => handle;
  return {
    spawnArg,
    emit(event, arg) {
      for (const cb of listeners.get(event) ?? []) cb(arg);
    },
    killCalls,
  };
}

function baseDeps(overrides: Partial<SuperviseDeps> = {}): {
  deps: SuperviseDeps;
  pidfile: DaemonPidfileDeps;
  events: Array<{
    event: string;
    data?: Record<string, unknown>;
    level?: 'info' | 'warn' | 'error';
  }>;
} {
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile(ROOT, 5000, pidfile);
  const events: Array<{
    event: string;
    data?: Record<string, unknown>;
    level?: 'info' | 'warn' | 'error';
  }> = [];
  const deps: SuperviseDeps = {
    spawn: () => {
      throw new Error('override deps.spawn in the test');
    },
    pidfile,
    logs: fakeLogDeps(),
    root: ROOT,
    home: HOME,
    nodeBin: 'node',
    cliEntry: 'src/cli/main.ts',
    runCapMs: 1_000,
    log: (event, data, level) => {
      events.push({ event, data, level });
    },
    // Default: a backstop that never fires, so tests that don't care
    // about it aren't affected by an immediate synchronous expiry.
    setTimeout: () => ({}),
    clearTimeout: () => {},
    ...overrides,
  };
  return { deps, pidfile, events };
}

test('records the child pid into inFlight after spawn() returns, and clears it on exit', async () => {
  const child = fakeChild(9001);
  const { deps, pidfile } = baseDeps({ spawn: child.spawnArg });
  const promise = createSpawnRun(deps)(OWED);
  const inFlight = readDaemonPidfile(ROOT, pidfile)?.inFlight;
  assert.equal(inFlight?.pid, 9001);
  assert.equal(inFlight?.profile, OWED.profile);
  assert.equal(typeof inFlight?.startedAt, 'string');
  child.emit('exit', 0);
  const code = await promise;
  assert.equal(code, 0);
  assert.equal(readDaemonPidfile(ROOT, pidfile)?.inFlight, undefined);
});

test('rotates runs.log (size check) then spawns, then closes its own fd copy, in that order', async () => {
  const calls: string[] = [];
  const logs: LogDeps = {
    existsSync: () => true,
    mkdirSync: () => calls.push('mkdir'),
    statSync: (p) => {
      calls.push(`stat:${p}`);
      return { size: 0 };
    },
    renameSync: () => calls.push('rename'),
    openSync: (p, flags) => {
      calls.push(`open:${p}:${flags}`);
      return 42;
    },
    closeSync: (fd) => calls.push(`close:${fd}`),
  };
  const child = fakeChild(9001);
  const spawn: SuperviseDeps['spawn'] = (command, args, opts) => {
    calls.push('spawn');
    return child.spawnArg(command, args, opts);
  };
  const { deps } = baseDeps({ logs, spawn });
  const promise = createSpawnRun(deps)(OWED);
  child.emit('exit', 0);
  await promise;
  assert.deepEqual(calls, [
    `stat:${RUNS_LOG_PATH}`,
    `open:${RUNS_LOG_PATH}:a`,
    'spawn',
    'close:42',
  ]);
});

/**
 * The three arguments the tests above forward without ever reading. Left
 * unasserted, dropping `--headless` (a daemon-spawned run must never try to
 * open a visible browser) or regressing `stdio` to `'inherit'` (which sends
 * the child's output to the daemon's own stdout instead of runs.log, losing
 * exactly the early-abort diagnostics the fd capture exists to preserve)
 * would leave this whole suite green.
 */
test('spawns <nodeBin> <cliEntry> run --profile <p> --headless, with stdio wired to the fd', async () => {
  const child = fakeChild(9001);
  let seen:
    | { command: string; args: readonly string[]; opts: { stdio: readonly unknown[] } }
    | undefined;
  const spawn: SuperviseDeps['spawn'] = (command, args, opts) => {
    seen = { command, args, opts };
    return child.spawnArg(command, args, opts);
  };
  const { deps } = baseDeps({ spawn });
  const promise = createSpawnRun(deps)(OWED);
  child.emit('exit', 0);
  await promise;

  assert.equal(seen?.command, deps.nodeBin);
  assert.deepEqual(seen?.args, [
    deps.cliEntry,
    'run',
    '--profile',
    OWED.profile,
    '--headless',
  ]);
  // 42 is fakeLogDeps()'s openSync return — the SAME fd on both stdout and
  // stderr, so a child's output and its stack traces interleave in one file.
  assert.deepEqual(seen?.opts.stdio, ['ignore', 42, 42]);
});

test('a spawn error event resolves to a nonzero code without throwing (A5/A7)', async () => {
  const child = fakeChild(undefined); // spawn() never produced a pid (ENOENT-shaped).
  const { deps, events } = baseDeps({ spawn: child.spawnArg });
  const promise = createSpawnRun(deps)(OWED);
  await assert.doesNotReject(async () => {
    child.emit('error', new Error('ENOENT'));
    assert.equal(await promise, 1);
  });
  assert.ok(events.some((e) => e.event === 'spawn-error'));
  assert.equal(events.find((e) => e.event === 'spawn-error')?.level, 'error');
});

interface FakeTimerEntry {
  ms: number;
  cb: () => void;
  // Declared (never implemented) so this satisfies SuperviseDeps['setTimeout']'s
  // `{ unref?(): void }` return type: with no property in common, TS's weak-type
  // check rejects the assignment outright. Leaving it undefined is also the
  // point of the fake — it proves the implementation's `handle.unref?.()` calls
  // tolerate a handle that has no unref, which is what a fake timer, and a
  // browser-shaped timer id, both are.
  unref?(): void;
}

function fakeTimers(): {
  setTimeout: SuperviseDeps['setTimeout'];
  clearTimeout: SuperviseDeps['clearTimeout'];
  pending: FakeTimerEntry[];
  fireEarliest(): void;
} {
  const pending: FakeTimerEntry[] = [];
  return {
    pending,
    setTimeout: (cb, ms) => {
      const entry: FakeTimerEntry = { ms, cb };
      pending.push(entry);
      return entry;
    },
    clearTimeout: (handle) => {
      const idx = pending.indexOf(handle as FakeTimerEntry);
      if (idx !== -1) pending.splice(idx, 1);
    },
    fireEarliest(): void {
      const entry = pending.shift();
      entry?.cb();
    },
  };
}

test('the backstop fires SIGTERM, then SIGKILL after SIGKILL_GRACE_MS, on expiry', async () => {
  const child = fakeChild(9001);
  const timers = fakeTimers();
  const { deps, events } = baseDeps({
    spawn: child.spawnArg,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    runCapMs: 1_000,
  });
  const promise = createSpawnRun(deps)(OWED);
  assert.equal(timers.pending[0]?.ms, 1_000 + BACKSTOP_MARGIN_MS);

  timers.fireEarliest(); // backstop expires.
  assert.deepEqual(child.killCalls, ['SIGTERM']);
  assert.equal(timers.pending[0]?.ms, SIGKILL_GRACE_MS);
  assert.ok(events.some((e) => e.event === 'backstop-expired'));
  assert.equal(events.find((e) => e.event === 'backstop-expired')?.level, 'warn');

  timers.fireEarliest(); // SIGKILL_GRACE_MS elapses.
  assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL']);

  // Node's real shape for a signal-killed child is ('exit', null, 'SIGKILL')
  // — the exit CODE is null, not 137 (that number is the shell's own
  // 128+SIGKILL convention, which the 'exit' event never reports). This is
  // therefore the exact payload the backstop's own kill produces, and it
  // exercises the implementation's `typeof code === 'number' ? code : 1`
  // guard: a signal death must be reported as a failure, never as a 0 that
  // would let the daemon record the slot as a clean run. The numeric branch
  // stays covered by the exit-0 emits in the tests around this one.
  child.emit('exit', null);
  assert.equal(await promise, 1);
});

test('the backstop timer is cleared when the child exits normally', async () => {
  const child = fakeChild(9001);
  const timers = fakeTimers();
  const { deps } = baseDeps({
    spawn: child.spawnArg,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const promise = createSpawnRun(deps)(OWED);
  assert.equal(timers.pending.length, 1);
  child.emit('exit', 0);
  await promise;
  assert.equal(timers.pending.length, 0); // cleared, not merely never fired.
});

test('the nested SIGKILL timer is also cleared when the child exits between SIGTERM and SIGKILL_GRACE_MS', async () => {
  const child = fakeChild(9001);
  const timers = fakeTimers();
  const { deps } = baseDeps({
    spawn: child.spawnArg,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    runCapMs: 1_000,
  });
  const promise = createSpawnRun(deps)(OWED);
  assert.equal(timers.pending.length, 1); // just the backstop, so far.

  timers.fireEarliest(); // backstop expires: SIGTERM sent, the nested SIGKILL timer arms.
  assert.deepEqual(child.killCalls, ['SIGTERM']);
  assert.equal(timers.pending.length, 1); // the nested SIGKILL timer, now pending.

  child.emit('exit', 0); // the child dies from SIGTERM before SIGKILL_GRACE_MS elapses.
  await promise;
  assert.equal(timers.pending.length, 0); // the nested timer was cleared too, not left dangling.
});

/**
 * Beyond the brief: Task 7's review left "the ledger append happens BEFORE
 * spawn" unpinned there, because daemon.test.ts has no seam where the spawn
 * ITSELF throws synchronously (its fake SpawnRun only ever rejects, which is
 * the `error`-event path above, not this one). This module is where the real
 * `spawn()` call lives, so the contract is pinned here instead: a synchronous
 * throw out of `deps.spawn` (EMFILE at fork time, a bad `nodeBin` path on
 * some platforms) escapes the Promise executor and REJECTS the returned
 * promise — it does NOT resolve to a code. That is the implementation's
 * natural behavior and it is safe: the throw happens strictly BEFORE the
 * `inFlight` write, so no phantom child is ever recorded, and daemon.ts's
 * tick loop already contains rejections from `deps.spawnRun` (ee4e035), so a
 * rejection costs one logged `tick-failed` rather than the daemon's life.
 * Task 7's ledger append — which happens before this function is even called
 * — still counts the slot as attempted, so this cannot become a retry storm.
 *
 * The fd must still be closed on this path. `openAppendFd` has already run by
 * the time `deps.spawn` throws, and nothing else will ever close that fd —
 * so without the implementation's try/catch the failure mode is
 * self-reinforcing: EMFILE (the most likely cause of a synchronous spawn
 * throw) leaks one more fd on every attempt, making the next EMFILE more
 * certain, on a daemon expected to live for months (D20).
 */
test('a synchronous throw from deps.spawn rejects, closes the fd, and leaves no inFlight', async () => {
  const closed: number[] = [];
  const logs: LogDeps = {
    ...fakeLogDeps(),
    closeSync: (fd) => {
      closed.push(fd);
    },
  };
  const { deps, pidfile } = baseDeps({
    logs,
    spawn: () => {
      throw new Error('EMFILE: too many open files');
    },
  });
  await assert.rejects(createSpawnRun(deps)(OWED), /EMFILE/);
  assert.deepEqual(closed, [42]); // the fd openAppendFd handed out, released.
  assert.equal(readDaemonPidfile(ROOT, pidfile)?.inFlight, undefined);
});
