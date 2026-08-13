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

test('parsePidfile: an old-shape pidfile with no degraded/schemaDriftNotifiedAt keys parses with safe defaults', () => {
  const deps = fakeDeps();
  setRaw(
    deps,
    JSON.stringify({
      pid: 1,
      startedAt: '2026-07-27T14:00:00.000Z',
      lastTickAt: '2026-07-27T14:00:00.000Z',
      attempts: [],
    }),
  );
  const stored = readDaemonPidfile(ROOT, deps);
  assert.deepEqual(stored?.degraded, []);
  assert.equal(stored?.schemaDriftNotifiedAt, null);
  // Absent key ⇒ null, same fallback as the other nullable-timestamp
  // latch/throttle fields — direct assertion (not transitive-only via the
  // round-trip test below), since `parsePidfile` builds its return as an
  // explicit field list where a field added to the interface alone is
  // silently dropped on the next read.
  assert.equal(stored?.schemaDriftNoNotifierWarnedAt, null);
  assert.equal(stored?.schemaDriftNotifyFailedAt, null);
});

test('parsePidfile: a malformed schemaDriftNoNotifierWarnedAt/schemaDriftNotifyFailedAt (non-string) parses to null, not trusted', () => {
  const deps = fakeDeps();
  setRaw(
    deps,
    JSON.stringify({
      pid: 1,
      startedAt: '2026-07-27T14:00:00.000Z',
      lastTickAt: '2026-07-27T14:00:00.000Z',
      attempts: [],
      schemaDriftNoNotifierWarnedAt: 12345,
      schemaDriftNotifyFailedAt: { not: 'a string' },
    }),
  );
  const stored = readDaemonPidfile(ROOT, deps);
  assert.equal(stored?.schemaDriftNoNotifierWarnedAt, null);
  assert.equal(stored?.schemaDriftNotifyFailedAt, null);
});

test('parsePidfile: a malformed degraded entry (missing a required field) is dropped, not trusted', () => {
  const deps = fakeDeps();
  setRaw(
    deps,
    JSON.stringify({
      pid: 1,
      startedAt: '2026-07-27T14:00:00.000Z',
      lastTickAt: '2026-07-27T14:00:00.000Z',
      attempts: [],
      degraded: [{ profile: 'harish' }],
    }),
  );
  const stored = readDaemonPidfile(ROOT, deps);
  assert.deepEqual(stored?.degraded, []);
});

test('updateDaemonPidfile + readDaemonPidfile: degraded, schemaDriftNotifiedAt, schemaDriftNoNotifierWarnedAt, and schemaDriftNotifyFailedAt round-trip through a write/read cycle', () => {
  const deps = fakeDeps();
  acquireDaemonPidfile(ROOT, 1000, deps);
  updateDaemonPidfile(
    ROOT,
    (current) => ({
      ...current,
      degraded: [
        {
          profile: 'harish',
          schemaVersion: 8,
          buildVersion: 7,
          detectedAt: '2026-08-13T10:00:00.000Z',
        },
      ],
      schemaDriftNotifiedAt: '2026-08-13T10:05:00.000Z',
      schemaDriftNoNotifierWarnedAt: '2026-08-13T10:06:00.000Z',
      schemaDriftNotifyFailedAt: '2026-08-13T10:07:00.000Z',
    }),
    deps,
  );
  const stored = readDaemonPidfile(ROOT, deps);
  assert.deepEqual(stored?.degraded, [
    {
      profile: 'harish',
      schemaVersion: 8,
      buildVersion: 7,
      detectedAt: '2026-08-13T10:00:00.000Z',
    },
  ]);
  assert.equal(stored?.schemaDriftNotifiedAt, '2026-08-13T10:05:00.000Z');
  // Direct assertions on the two fields the transitive-only coverage gap
  // was about: `parsePidfile` builds its return as an explicit field
  // list, so a field added to the `DaemonPidfile` interface alone (with no
  // matching line in that return construction) is silently dropped on the
  // very next read — this is the class of bug the direct round-trip catches
  // and a transitive test (e.g. via `daemon.ts`) would not reliably.
  assert.equal(stored?.schemaDriftNoNotifierWarnedAt, '2026-08-13T10:06:00.000Z');
  assert.equal(stored?.schemaDriftNotifyFailedAt, '2026-08-13T10:07:00.000Z');
});

test('parsePidfile: an old-shape pidfile with no lastGateDecline key parses with lastGateDecline undefined', () => {
  const deps = fakeDeps();
  setRaw(
    deps,
    JSON.stringify({
      pid: 1,
      startedAt: '2026-07-27T14:00:00.000Z',
      lastTickAt: '2026-07-27T14:00:00.000Z',
      attempts: [],
    }),
  );
  const stored = readDaemonPidfile(ROOT, deps);
  assert.equal(stored?.lastGateDecline, undefined);
});

test('parsePidfile: a malformed lastGateDecline (missing a required sub-field, or an invalid reasonCode) is dropped, not trusted', () => {
  const deps = fakeDeps();
  setRaw(
    deps,
    JSON.stringify({
      pid: 1,
      startedAt: '2026-07-27T14:00:00.000Z',
      lastTickAt: '2026-07-27T14:00:00.000Z',
      attempts: [],
      lastGateDecline: { reasonCode: 'host-asleep', reason: 'x' }, // missing `at`
    }),
  );
  const stored = readDaemonPidfile(ROOT, deps);
  assert.equal(stored?.lastGateDecline, undefined);

  const deps2 = fakeDeps();
  setRaw(
    deps2,
    JSON.stringify({
      pid: 1,
      startedAt: '2026-07-27T14:00:00.000Z',
      lastTickAt: '2026-07-27T14:00:00.000Z',
      attempts: [],
      // Valid for DeferredSlotRow's three-value union, but NOT for
      // lastGateDecline's own narrower two-value union — must be dropped.
      lastGateDecline: {
        reasonCode: 'daemon-unavailable',
        reason: 'x',
        at: '2026-08-13T10:00:00.000Z',
      },
    }),
  );
  const stored2 = readDaemonPidfile(ROOT, deps2);
  assert.equal(stored2?.lastGateDecline, undefined);
});

test('updateDaemonPidfile + readDaemonPidfile: lastGateDecline round-trips through a write/read cycle', () => {
  const deps = fakeDeps();
  acquireDaemonPidfile(ROOT, 1000, deps);
  updateDaemonPidfile(
    ROOT,
    (current) => ({
      ...current,
      lastGateDecline: {
        reasonCode: 'network-unreachable',
        reason:
          'Job Bunny declined to start this run because the network was unreachable.',
        at: '2026-08-13T10:00:00.000Z',
      },
    }),
    deps,
  );
  const stored = readDaemonPidfile(ROOT, deps);
  assert.deepEqual(stored?.lastGateDecline, {
    reasonCode: 'network-unreachable',
    reason: 'Job Bunny declined to start this run because the network was unreachable.',
    at: '2026-08-13T10:00:00.000Z',
  });
});

test('updateDaemonPidfile + readDaemonPidfile: a second lastGateDecline write overwrites the first, not accumulates', () => {
  const deps = fakeDeps();
  acquireDaemonPidfile(ROOT, 1000, deps);
  updateDaemonPidfile(
    ROOT,
    (current) => ({
      ...current,
      lastGateDecline: {
        reasonCode: 'host-asleep',
        reason: 'first decline',
        at: '2026-08-13T10:00:00.000Z',
      },
    }),
    deps,
  );
  updateDaemonPidfile(
    ROOT,
    (current) => ({
      ...current,
      lastGateDecline: {
        reasonCode: 'network-unreachable',
        reason: 'second decline',
        at: '2026-08-13T10:05:00.000Z',
      },
    }),
    deps,
  );
  const stored = readDaemonPidfile(ROOT, deps);
  assert.deepEqual(stored?.lastGateDecline, {
    reasonCode: 'network-unreachable',
    reason: 'second decline',
    at: '2026-08-13T10:05:00.000Z',
  });
});

test('defaultDaemonPidfileDeps: builds a working real-fs deps object shape', () => {
  const deps = defaultDaemonPidfileDeps();
  assert.equal(typeof deps.now, 'function');
  assert.equal(typeof deps.pidIsAlive, 'function');
  assert.equal(deps.pidIsAlive(process.pid), true); // our own process is definitely alive.
});
