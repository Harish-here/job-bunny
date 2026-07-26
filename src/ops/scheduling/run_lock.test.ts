/**
 * run_lock.test.ts — TDD for `acquireRunLock`/`releaseRunLock`. Every
 * dependency is an in-memory fake (`fakeDeps`) — no real filesystem write
 * and no real process ever touched, mirroring `run.test.ts`'s own
 * "every dependency is FAKE" convention.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acquireRunLock,
  defaultRunLockDeps,
  type LockInfo,
  type RunLockDeps,
  releaseRunLock,
} from './run_lock.ts';

const LOCK_PATH = '/fake/root/.jobbunny-run.lock';

function fakeDeps(overrides: Partial<RunLockDeps> = {}): RunLockDeps {
  const files = new Map<string, string>();
  const alivePids = new Set<number>();

  const deps: RunLockDeps = {
    lockPath: LOCK_PATH,
    pid: 1000,
    now: () => new Date('2026-07-25T10:00:00Z'),
    pidIsAlive: (pid) => alivePids.has(pid),
    readFile: (p) => {
      const content = files.get(p);
      if (content === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    },
    writeFileExclusive: (p, content) => {
      if (files.has(p)) {
        const err = new Error('EEXIST') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }
      files.set(p, content);
    },
    unlink: (p) => {
      if (!files.has(p)) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      files.delete(p);
    },
    ...overrides,
  };

  // Expose the in-memory store/alive-set for tests that need to seed state
  // directly (bypassing acquireRunLock itself).
  (
    deps as RunLockDeps & { _files: Map<string, string>; _alivePids: Set<number> }
  )._files = files;
  (
    deps as RunLockDeps & { _files: Map<string, string>; _alivePids: Set<number> }
  )._alivePids = alivePids;
  return deps;
}

function seedLock(deps: RunLockDeps, info: LockInfo): void {
  (deps as unknown as { _files: Map<string, string> })._files.set(
    deps.lockPath,
    JSON.stringify(info),
  );
}

function markAlive(deps: RunLockDeps, pid: number): void {
  (deps as unknown as { _alivePids: Set<number> })._alivePids.add(pid);
}

test('acquireRunLock: succeeds when no lock file exists', () => {
  const deps = fakeDeps();
  const result = acquireRunLock(deps, 'rajni');
  assert.deepEqual(result, { acquired: true });
});

test('acquireRunLock: refuses when the lock is held by a live process, reporting who holds it', () => {
  const deps = fakeDeps({ pid: 2000 });
  seedLock(deps, { pid: 1000, profile: 'harish', startedAt: '2026-07-25T09:55:00Z' });
  markAlive(deps, 1000);

  const result = acquireRunLock(deps, 'rajni');
  assert.equal(result.acquired, false);
  if (!result.acquired) {
    assert.deepEqual(result.heldBy, {
      pid: 1000,
      profile: 'harish',
      startedAt: '2026-07-25T09:55:00Z',
    });
  }
});

test('acquireRunLock: steals a lock whose pid is no longer alive (crash recovery)', () => {
  const deps = fakeDeps({ pid: 2000 });
  seedLock(deps, { pid: 1000, profile: 'harish', startedAt: '2026-07-25T09:00:00Z' });
  // 1000 is NOT marked alive — simulates a SIGKILLed prior run.

  const result = acquireRunLock(deps, 'rajni');
  assert.deepEqual(result, { acquired: true });
});

test('acquireRunLock: steals a lock older than maxAgeMs even if the pid still reports alive', () => {
  const deps = fakeDeps({ pid: 2000, maxAgeMs: 60_000 });
  markAlive(deps, 1000);
  seedLock(deps, { pid: 1000, profile: 'harish', startedAt: '2026-07-25T08:00:00Z' }); // 2h old

  const result = acquireRunLock(deps, 'rajni');
  assert.deepEqual(result, { acquired: true });
});

test('acquireRunLock: does NOT steal a live lock within maxAgeMs (a legitimately slow run)', () => {
  const deps = fakeDeps({ pid: 2000, maxAgeMs: 4 * 60 * 60 * 1000 });
  markAlive(deps, 1000);
  seedLock(deps, { pid: 1000, profile: 'harish', startedAt: '2026-07-25T08:00:00Z' }); // 2h old

  const result = acquireRunLock(deps, 'rajni');
  assert.equal(result.acquired, false);
});

test('acquireRunLock: treats a corrupt lock file as stale and steals it', () => {
  const deps = fakeDeps({ pid: 2000 });
  (deps as unknown as { _files: Map<string, string> })._files.set(
    deps.lockPath,
    'not json{{{',
  );

  const result = acquireRunLock(deps, 'rajni');
  assert.deepEqual(result, { acquired: true });
});

test('releaseRunLock: removes a lock this process owns', () => {
  const deps = fakeDeps({ pid: 1000 });
  seedLock(deps, { pid: 1000, profile: 'rajni', startedAt: '2026-07-25T10:00:00Z' });

  releaseRunLock(deps);

  assert.throws(() => deps.readFile(deps.lockPath));
});

test('releaseRunLock: does NOT remove a lock owned by a different pid (already stolen)', () => {
  const deps = fakeDeps({ pid: 1000 });
  seedLock(deps, {
    pid: 9999,
    profile: 'someone-else',
    startedAt: '2026-07-25T10:00:00Z',
  });

  releaseRunLock(deps);

  assert.equal(
    deps.readFile(deps.lockPath),
    JSON.stringify({
      pid: 9999,
      profile: 'someone-else',
      startedAt: '2026-07-25T10:00:00Z',
    }),
  );
});

test('releaseRunLock: is a no-op when the lock file is already absent', () => {
  const deps = fakeDeps({ pid: 1000 });
  assert.doesNotThrow(() => releaseRunLock(deps));
});

test('acquireRunLock -> releaseRunLock: full round trip lets a second acquire succeed after release', () => {
  const deps = fakeDeps({ pid: 1000 });
  markAlive(deps, 1000); // otherwise the contested acquire below would treat it as stale.
  const first = acquireRunLock(deps, 'rajni');
  assert.deepEqual(first, { acquired: true });

  const contested = acquireRunLock({ ...deps, pid: 2000 }, 'harish');
  assert.equal(contested.acquired, false);

  releaseRunLock(deps);

  const second = acquireRunLock({ ...deps, pid: 2000 }, 'harish');
  assert.deepEqual(second, { acquired: true });
});

test('defaultRunLockDeps: builds a working real-fs deps object shape', () => {
  const deps = defaultRunLockDeps('/tmp/does-not-matter.lock');
  assert.equal(typeof deps.pid, 'number');
  assert.equal(typeof deps.now, 'function');
  assert.equal(typeof deps.pidIsAlive, 'function');
  assert.equal(deps.pidIsAlive(process.pid), true); // our own process is definitely alive.
});
