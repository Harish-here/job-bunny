import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LinkedinBreakerDeps, LinkedinBreakerState } from './breaker_store.ts';
import {
  breakerPhase,
  closeBreaker,
  defaultLinkedinBreakerDeps,
  linkedinBreakerPath,
  openBreaker,
  readBreaker,
  recordProbe,
} from './breaker_store.ts';

const USER_DATA_DIR = '/repo/.chrome-debug';
// Built via node:path's join (not a literal) so the expected value tracks
// whatever separator the host platform produces — linkedinBreakerPath is
// implemented with join too. Same posture as pidfile.test.ts.
const BREAKER_PATH = join(USER_DATA_DIR, '.jobbunny-linkedin-breaker.json');

const NOW = new Date('2026-07-28T12:00:00.000Z');
const COOLDOWN_MS = 4 * 60 * 60 * 1000;

function fakeDeps(overrides: Partial<LinkedinBreakerDeps> = {}): LinkedinBreakerDeps {
  return {
    existsSync: () => false,
    readFileSync: () => {
      throw new Error('no file');
    },
    writeFileSync: () => {},
    mkdirSync: () => {},
    unlinkSync: () => {},
    now: () => NOW,
    ...overrides,
  };
}

/** fakeDeps with a file "on disk" holding exactly `raw`. */
function storedDeps(
  raw: string,
  overrides: Partial<LinkedinBreakerDeps> = {},
): LinkedinBreakerDeps {
  return fakeDeps({ existsSync: () => true, readFileSync: () => raw, ...overrides });
}

test('linkedinBreakerPath joins userDataDir with the fixed breaker file name', () => {
  assert.equal(linkedinBreakerPath(USER_DATA_DIR), BREAKER_PATH);
});

// --- readBreaker ---

test('readBreaker: no file -> undefined, and readFileSync is never called', () => {
  let reads = 0;
  const deps = fakeDeps({
    readFileSync: () => {
      reads += 1;
      return '';
    },
  });
  assert.equal(readBreaker(USER_DATA_DIR, deps), undefined);
  assert.equal(reads, 0);
});

test('readBreaker: a well-formed file round-trips, including the optional lastProbeAt', () => {
  const state: LinkedinBreakerState = {
    openedAt: '2026-07-28T09:00:00.000Z',
    tripCount: 2,
    lastProbeAt: '2026-07-28T11:00:00.000Z',
  };
  assert.deepEqual(readBreaker(USER_DATA_DIR, storedDeps(JSON.stringify(state))), state);
});

test('readBreaker: reads the path linkedinBreakerPath produces', () => {
  const paths: string[] = [];
  const deps = storedDeps('{"openedAt":"2026-07-28T09:00:00.000Z","tripCount":1}', {
    existsSync: (path) => {
      paths.push(path);
      return true;
    },
  });
  readBreaker(USER_DATA_DIR, deps);
  assert.deepEqual(paths, [BREAKER_PATH]);
});

test('readBreaker: unparseable JSON -> undefined, never throws, and does NOT delete the file', () => {
  let unlinks = 0;
  const deps = storedDeps('{not json', {
    unlinkSync: () => {
      unlinks += 1;
    },
  });
  assert.equal(readBreaker(USER_DATA_DIR, deps), undefined);
  assert.equal(unlinks, 0);
});

test('readBreaker: wrong shape (tripCount not a number) -> undefined', () => {
  const raw = JSON.stringify({ openedAt: '2026-07-28T09:00:00.000Z', tripCount: 'two' });
  assert.equal(readBreaker(USER_DATA_DIR, storedDeps(raw)), undefined);
});

test('readBreaker: an openedAt that is not a parseable date -> undefined', () => {
  const raw = JSON.stringify({ openedAt: 'yesterday-ish', tripCount: 1 });
  assert.equal(readBreaker(USER_DATA_DIR, storedDeps(raw)), undefined);
});

test('readBreaker: an unreadable file (EACCES) -> undefined, never throws', () => {
  const deps = fakeDeps({
    existsSync: () => true,
    readFileSync: () => {
      throw new Error('EACCES: permission denied');
    },
  });
  assert.equal(readBreaker(USER_DATA_DIR, deps), undefined);
});

// --- breakerPhase ---

function stateOpenedAt(iso: string): LinkedinBreakerState {
  return { openedAt: iso, tripCount: 1 };
}

test('breakerPhase: no state at all -> closed', () => {
  assert.equal(breakerPhase(undefined, NOW, COOLDOWN_MS), 'closed');
});

test('breakerPhase: inside the cooldown window -> open', () => {
  // Opened 1h ago, 4h cooldown.
  assert.equal(
    breakerPhase(stateOpenedAt('2026-07-28T11:00:00.000Z'), NOW, COOLDOWN_MS),
    'open',
  );
});

test('breakerPhase: exactly AT the boundary -> half-open (>= is recovery, not still-open)', () => {
  assert.equal(
    breakerPhase(stateOpenedAt('2026-07-28T08:00:00.000Z'), NOW, COOLDOWN_MS),
    'half-open',
  );
});

test('breakerPhase: one millisecond before the boundary is still open', () => {
  assert.equal(
    breakerPhase(stateOpenedAt('2026-07-28T08:00:00.001Z'), NOW, COOLDOWN_MS),
    'open',
  );
});

test('breakerPhase: well past the window -> half-open', () => {
  assert.equal(
    breakerPhase(stateOpenedAt('2026-07-27T08:00:00.000Z'), NOW, COOLDOWN_MS),
    'half-open',
  );
});

test('breakerPhase: a corrupt openedAt is treated as closed, never as a permanent block (D12)', () => {
  assert.equal(breakerPhase(stateOpenedAt('not-a-date'), NOW, COOLDOWN_MS), 'closed');
});

// --- openBreaker ---

test('openBreaker: writes openedAt=now and tripCount=1 when there was no prior state', () => {
  const writes: Array<{ path: string; data: string }> = [];
  const deps = fakeDeps({
    writeFileSync: (path, data) => {
      writes.push({ path, data });
    },
  });

  assert.equal(openBreaker(USER_DATA_DIR, deps), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.path, BREAKER_PATH);
  assert.deepEqual(JSON.parse(writes[0]?.data ?? '{}'), {
    openedAt: NOW.toISOString(),
    tripCount: 1,
  });
});

test('openBreaker: increments a prior tripCount and preserves lastProbeAt', () => {
  const writes: string[] = [];
  const deps = fakeDeps({
    writeFileSync: (_path, data) => {
      writes.push(data);
    },
  });
  const prev: LinkedinBreakerState = {
    openedAt: '2026-07-28T04:00:00.000Z',
    tripCount: 3,
    lastProbeAt: '2026-07-28T11:59:00.000Z',
  };

  assert.equal(openBreaker(USER_DATA_DIR, deps, prev), true);
  assert.deepEqual(JSON.parse(writes[0] ?? '{}'), {
    openedAt: NOW.toISOString(),
    tripCount: 4,
    lastProbeAt: '2026-07-28T11:59:00.000Z',
  });
});

test('openBreaker: creates userDataDir BEFORE writing (a fresh clone has no .chrome-debug/)', () => {
  const order: string[] = [];
  const deps = fakeDeps({
    mkdirSync: (path) => {
      order.push(`mkdir:${path}`);
    },
    writeFileSync: (path) => {
      order.push(`write:${path}`);
    },
  });

  openBreaker(USER_DATA_DIR, deps);

  assert.deepEqual(order, [`mkdir:${USER_DATA_DIR}`, `write:${BREAKER_PATH}`]);
});

test('openBreaker: a failed write returns false and never throws (D12 — fail toward working)', () => {
  const deps = fakeDeps({
    writeFileSync: () => {
      throw new Error('ENOSPC: no space left on device');
    },
  });
  assert.equal(openBreaker(USER_DATA_DIR, deps), false);
});

test('openBreaker: a failed mkdir returns false and never throws', () => {
  const deps = fakeDeps({
    mkdirSync: () => {
      throw new Error('EACCES: permission denied');
    },
  });
  assert.equal(openBreaker(USER_DATA_DIR, deps), false);
});

// --- recordProbe ---

test('recordProbe: stamps lastProbeAt while leaving openedAt and tripCount untouched', () => {
  const writes: string[] = [];
  const deps = fakeDeps({
    writeFileSync: (_path, data) => {
      writes.push(data);
    },
  });
  const prev: LinkedinBreakerState = {
    openedAt: '2026-07-28T04:00:00.000Z',
    tripCount: 2,
  };

  assert.equal(recordProbe(USER_DATA_DIR, deps, prev), true);
  assert.deepEqual(JSON.parse(writes[0] ?? '{}'), {
    openedAt: '2026-07-28T04:00:00.000Z',
    tripCount: 2,
    lastProbeAt: NOW.toISOString(),
  });
});

test('recordProbe: with no prior state it writes nothing — stamping a probe must never OPEN the breaker', () => {
  let writes = 0;
  const deps = fakeDeps({
    writeFileSync: () => {
      writes += 1;
    },
  });
  assert.equal(recordProbe(USER_DATA_DIR, deps, undefined), false);
  assert.equal(writes, 0);
});

test('recordProbe: a failed write returns false and never throws', () => {
  const deps = fakeDeps({
    writeFileSync: () => {
      throw new Error('EROFS: read-only file system');
    },
  });
  const prev: LinkedinBreakerState = {
    openedAt: '2026-07-28T04:00:00.000Z',
    tripCount: 1,
  };
  assert.equal(recordProbe(USER_DATA_DIR, deps, prev), false);
});

// --- closeBreaker ---

test('closeBreaker: unlinks the breaker file', () => {
  const unlinked: string[] = [];
  const deps = fakeDeps({
    existsSync: () => true,
    unlinkSync: (path) => {
      unlinked.push(path);
    },
  });
  closeBreaker(USER_DATA_DIR, deps);
  assert.deepEqual(unlinked, [BREAKER_PATH]);
});

test('closeBreaker: tolerates a missing file (ENOENT) without throwing', () => {
  const deps = fakeDeps({
    existsSync: () => true,
    unlinkSync: () => {
      throw new Error('ENOENT: no such file or directory');
    },
  });
  assert.doesNotThrow(() => closeBreaker(USER_DATA_DIR, deps));
});

// --- defaultLinkedinBreakerDeps ---

test('defaultLinkedinBreakerDeps supplies every dep and a real clock', () => {
  const deps = defaultLinkedinBreakerDeps();
  for (const key of [
    'existsSync',
    'readFileSync',
    'writeFileSync',
    'mkdirSync',
    'unlinkSync',
    'now',
  ] as const) {
    assert.equal(typeof deps[key], 'function', `${key} must be provided`);
  }
  assert.ok(deps.now() instanceof Date);
  // No pidIsAlive: unlike the Chrome pid file this state describes a
  // time window, not a process.
  assert.equal('pidIsAlive' in deps, false);
});
