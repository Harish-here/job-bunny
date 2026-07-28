import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  acquireDaemonPidfile,
  type DaemonPidfileDeps,
  daemonPidfilePath,
  defaultDaemonPidfileDeps,
  HEARTBEAT_STALE_MS,
  isDaemonPidfileStale,
  readDaemonPidfile,
  releaseDaemonPidfile,
  updateDaemonPidfile,
} from './pidfile.ts';

const ROOT = '/fake/root';

function fakeDeps(): DaemonPidfileDeps & {
  _files: Map<string, string>;
  _alivePids: Set<number>;
  _advance: (ms: number) => void;
} {
  const files = new Map<string, string>();
  const alivePids = new Set<number>();
  let nowMs = Date.parse('2026-07-27T14:00:00.000Z');

  const notFound = (): never => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };

  return {
    _files: files,
    _alivePids: alivePids,
    _advance: (ms) => {
      nowMs += ms;
    },
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
      if (!files.has(p)) notFound();
      files.delete(p);
    },
    pidIsAlive: (pid) => alivePids.has(pid),
    now: () => new Date(nowMs),
  };
}

test('daemonPidfilePath: sibling to .jobbunny-run.lock', () => {
  assert.equal(daemonPidfilePath(ROOT), join(ROOT, '.jobbunny-daemon.pid'));
});

test('acquireDaemonPidfile: succeeds on a clean directory', () => {
  const deps = fakeDeps();
  const acquired = acquireDaemonPidfile(ROOT, 1000, deps);
  assert.equal(acquired, true);
  const stored = readDaemonPidfile(ROOT, deps);
  assert.equal(stored?.pid, 1000);
  assert.deepEqual(stored?.attempts, []);
});

function advance(deps: DaemonPidfileDeps, ms: number): void {
  (deps as unknown as { _advance: (ms: number) => void })._advance(ms);
}

function markAlive(deps: DaemonPidfileDeps, pid: number): void {
  (deps as unknown as { _alivePids: Set<number> })._alivePids.add(pid);
}

function setRaw(deps: DaemonPidfileDeps, content: string): void {
  (deps as unknown as { _files: Map<string, string> })._files.set(
    daemonPidfilePath(ROOT),
    content,
  );
}

test('acquireDaemonPidfile: fails when the pidfile exists with a live pid', () => {
  const deps = fakeDeps();
  acquireDaemonPidfile(ROOT, 1000, deps);
  markAlive(deps, 1000);
  const acquired = acquireDaemonPidfile(ROOT, 2000, deps);
  assert.equal(acquired, false);
});

test('isDaemonPidfileStale: a dead pid is stale', () => {
  const deps = fakeDeps();
  acquireDaemonPidfile(ROOT, 1000, deps);
  // 1000 is never marked alive — simulates a crashed daemon.
  const file = readDaemonPidfile(ROOT, deps);
  assert.equal(isDaemonPidfileStale(file, deps), true);
});

test('isDaemonPidfileStale: a fresh lastTickAt on a live pid is NOT stale', () => {
  const deps = fakeDeps();
  acquireDaemonPidfile(ROOT, 1000, deps);
  markAlive(deps, 1000);
  const file = readDaemonPidfile(ROOT, deps);
  assert.equal(isDaemonPidfileStale(file, deps), false);
});

test('isDaemonPidfileStale: a lastTickAt six minutes old on a live pid IS stale', () => {
  const deps = fakeDeps();
  acquireDaemonPidfile(ROOT, 1000, deps);
  markAlive(deps, 1000);
  advance(deps, 6 * 60_000);
  const file = readDaemonPidfile(ROOT, deps);
  assert.equal(isDaemonPidfileStale(file, deps), true);
});

test('isDaemonPidfileStale: an unparseable lastTickAt on a live pid IS stale', () => {
  const deps = fakeDeps();
  acquireDaemonPidfile(ROOT, 1000, deps);
  markAlive(deps, 1000);
  // A corrupt heartbeat yields a NaN age. Calling that "not stale" would
  // pin a wedged daemon in place forever — no `serve start` could steal
  // it — and contradicts what `serve status` already prints for the same
  // file ("age unknown — appears wedged").
  updateDaemonPidfile(ROOT, (c) => ({ ...c, lastTickAt: 'not-a-date' }), deps);
  const file = readDaemonPidfile(ROOT, deps);
  assert.equal(file?.lastTickAt, 'not-a-date'); // it really is a parsed pidfile.
  assert.equal(isDaemonPidfileStale(file, deps), true);
});

test('isDaemonPidfileStale: exactly at HEARTBEAT_STALE_MS is NOT yet stale', () => {
  const deps = fakeDeps();
  acquireDaemonPidfile(ROOT, 1000, deps);
  markAlive(deps, 1000);
  advance(deps, HEARTBEAT_STALE_MS);
  const file = readDaemonPidfile(ROOT, deps);
  assert.equal(isDaemonPidfileStale(file, deps), false);
});

test('updateDaemonPidfile: writes to a .tmp path then renames it over the real path, in order', () => {
  const deps = fakeDeps();
  acquireDaemonPidfile(ROOT, 1000, deps);
  const path = daemonPidfilePath(ROOT);
  const calls: string[] = [];
  const tracked: DaemonPidfileDeps = {
    ...deps,
    writeFileSync: (p, data) => {
      calls.push(`write:${p}`);
      deps.writeFileSync(p, data);
    },
    renameSync: (from, to) => {
      calls.push(`rename:${from}->${to}`);
      deps.renameSync(from, to);
    },
  };
  const inFlight = {
    pid: 4242,
    profile: 'harish',
    startedAt: '2026-07-27T14:00:00.000Z',
  };
  updateDaemonPidfile(ROOT, (current) => ({ ...current, inFlight }), tracked);
  assert.deepEqual(calls, [`write:${path}.tmp`, `rename:${path}.tmp->${path}`]);
  assert.deepEqual(readDaemonPidfile(ROOT, deps)?.inFlight, inFlight);
});

test('updateDaemonPidfile: appends an attempts-ledger entry and reports true', () => {
  const deps = fakeDeps();
  acquireDaemonPidfile(ROOT, 1000, deps);
  const written = updateDaemonPidfile(
    ROOT,
    (current) => ({
      ...current,
      attempts: [
        ...current.attempts,
        { profile: 'harish', date: '2026-07-27', slot: '14:00' },
      ],
    }),
    deps,
  );
  assert.equal(written, true);
  assert.deepEqual(readDaemonPidfile(ROOT, deps)?.attempts, [
    { profile: 'harish', date: '2026-07-27', slot: '14:00' },
  ]);
});

test('updateDaemonPidfile: reports false (not silence) when the pidfile is unreadable', () => {
  const deps = fakeDeps();
  // Never acquired — nothing safe to mutate. The return value is what lets
  // daemon.ts refuse to spawn a run whose ledger append never landed.
  const missing = updateDaemonPidfile(ROOT, (c) => c, deps);
  assert.equal(missing, false);

  setRaw(deps, 'not json{{{');
  const corrupt = updateDaemonPidfile(ROOT, (c) => c, deps);
  assert.equal(corrupt, false);
});

test('readDaemonPidfile: unparseable content is treated as stale (undefined)', () => {
  const deps = fakeDeps();
  setRaw(deps, 'not json{{{');
  const file = readDaemonPidfile(ROOT, deps);
  assert.equal(file, undefined);
  assert.equal(isDaemonPidfileStale(file, deps), true);
});

test('releaseDaemonPidfile: removes the pidfile', () => {
  const deps = fakeDeps();
  acquireDaemonPidfile(ROOT, 1000, deps);
  releaseDaemonPidfile(ROOT, deps);
  assert.equal(readDaemonPidfile(ROOT, deps), undefined);
});

test('releaseDaemonPidfile: is a no-op when the pidfile is already absent', () => {
  const deps = fakeDeps();
  assert.doesNotThrow(() => releaseDaemonPidfile(ROOT, deps));
});

test('defaultDaemonPidfileDeps: builds a working real-fs deps object shape', () => {
  const deps = defaultDaemonPidfileDeps();
  assert.equal(typeof deps.now, 'function');
  assert.equal(typeof deps.pidIsAlive, 'function');
  assert.equal(deps.pidIsAlive(process.pid), true); // our own process is definitely alive.
});
