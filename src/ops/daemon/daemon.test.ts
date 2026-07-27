import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProfileSchedule } from '../../core/schedule/index.ts';
import type { DaemonDeps, SpawnRun } from './daemon.ts';
import { createDaemon } from './daemon.ts';
import type { DaemonPidfileDeps } from './pidfile.ts';
import {
  acquireDaemonPidfile,
  readDaemonPidfile,
  updateDaemonPidfile,
} from './pidfile.ts';
import type { ScanDeps } from './scan/index.ts';

const ROOT = '/fake/root';
const PROFILES_DIR = '/fake/profiles';

function profilePath(name: string): string {
  return join(PROFILES_DIR, name, 'profile.json');
}

function profileJson(schedule: Partial<ProfileSchedule> & { times: string[] }): string {
  return JSON.stringify({
    connector: 'notion',
    schedule: {
      times: schedule.times,
      enabled: schedule.enabled ?? true,
      weekdays: schedule.weekdays ?? [1, 2, 3, 4, 5],
      graceMinutes: schedule.graceMinutes ?? 90,
    },
  });
}

function fakeScanDeps(
  files: Record<string, string>,
  dirs: Record<string, string[]>,
): ScanDeps {
  return {
    existsSync: (p) => p in files || p in dirs,
    readdirSync: (p) => {
      const entries = dirs[p];
      if (!entries) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return entries;
    },
    readFileSync: (p) => {
      const content = files[p];
      if (content === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    },
  };
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

function readLastTickAt(deps: DaemonDeps): string | undefined {
  return readDaemonPidfile(deps.root, deps.pidfile)?.lastTickAt;
}

function baseDeps(overrides: Partial<DaemonDeps> = {}): {
  deps: DaemonDeps;
  events: Array<{ event: string; data?: Record<string, unknown> }>;
} {
  const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile(ROOT, 5000, pidfile);

  const deps: DaemonDeps = {
    root: ROOT,
    profilesDir: PROFILES_DIR,
    scan: fakeScanDeps({}, {}),
    pidfile,
    spawnRun: (async () => 0) as SpawnRun,
    log: (event, data) => {
      events.push({ event, data });
    },
    now: () => new Date(2026, 6, 27, 14, 4), // 2026-07-27 is a Monday.
    ...overrides,
  };
  return { deps, events };
}

test('a due slot spawns exactly once', async () => {
  const spawnCalls: string[] = [];
  const spawnRun: SpawnRun = async (owed) => {
    spawnCalls.push(owed.profile);
    return 0;
  };
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  const { deps } = baseDeps({ scan, spawnRun });
  await createDaemon(deps).tick();
  assert.deepEqual(spawnCalls, ['harish']);
});

test('a second tick during an in-flight run short-circuits on the guard but still advances lastTickAt', async () => {
  let nowMs = new Date(2026, 6, 27, 14, 4).getTime();
  const now = () => new Date(nowMs);

  let resolveSpawn: ((code: number) => void) | undefined;
  const spawnRun: SpawnRun = () =>
    new Promise((resolve) => {
      resolveSpawn = resolve;
    });
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  const { deps, events } = baseDeps({ scan, spawnRun, now });
  const daemon = createDaemon(deps);

  const firstTick = daemon.tick();
  await Promise.resolve();
  await Promise.resolve(); // let the heartbeat write and ledger append settle.

  const beforeSecondTick = readLastTickAt(deps);
  nowMs += 1000;
  await daemon.tick(); // short-circuits on the reentrancy guard.
  const afterSecondTick = readLastTickAt(deps);

  assert.notEqual(afterSecondTick, beforeSecondTick); // heartbeat still advanced.
  assert.equal(events.filter((e) => e.event === 'spawn').length, 1); // no 2nd spawn attempt.

  resolveSpawn?.(0);
  await firstTick;
});

test('a heartbeat write that throws is swallowed and the tick continues', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  const spawnCalls: string[] = [];
  const spawnRun: SpawnRun = async (owed) => {
    spawnCalls.push(owed.profile);
    return 0;
  };
  const { deps, events } = baseDeps({ scan, spawnRun });

  let calls = 0;
  const originalWrite = deps.pidfile.writeFileSync;
  deps.pidfile.writeFileSync = (p, data) => {
    calls += 1;
    if (calls === 1) throw new Error('ENOSPC'); // the heartbeat write — first of the tick.
    originalWrite(p, data);
  };

  await assert.doesNotReject(() => createDaemon(deps).tick());
  assert.equal(spawnCalls.length, 1); // the batch still ran despite the heartbeat failure.
  assert.ok(events.some((e) => e.event === 'heartbeat-write-failed'));
});

test('a ledger entry suppresses a respawn for a slot with no run folder', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
    { [PROFILES_DIR]: ['harish'] }, // no runs/2026-07-27 dir — nothing ever checkpointed.
  );
  const spawnCalls: string[] = [];
  const spawnRun: SpawnRun = async (owed) => {
    spawnCalls.push(owed.profile);
    return 0;
  };
  const { deps } = baseDeps({ scan, spawnRun });

  await createDaemon(deps).tick(); // spawns and ledgers the attempt.
  assert.deepEqual(spawnCalls, ['harish']);

  await createDaemon(deps).tick(); // same slot, still no run folder.
  assert.deepEqual(spawnCalls, ['harish']); // NOT spawned again — the ledger entry served it.
});

test('an entry whose grace window expired during a predecessor run is skipped and NOT ledgered', async () => {
  let nowMs = new Date(2026, 6, 27, 9, 6).getTime();
  const now = () => new Date(nowMs);

  const scan = fakeScanDeps(
    {
      [profilePath('alpha')]: profileJson({ times: ['09:00'], graceMinutes: 90 }),
      [profilePath('beta')]: profileJson({ times: ['09:05'], graceMinutes: 5 }),
    },
    { [PROFILES_DIR]: ['alpha', 'beta'] },
  );

  const spawnCalls: string[] = [];
  const spawnRun: SpawnRun = async (owed) => {
    spawnCalls.push(owed.profile);
    if (owed.profile === 'alpha') {
      // alpha's run "takes long enough" that beta's own 5-minute grace
      // window (09:05-09:10) has since expired by the time its turn comes.
      nowMs = new Date(2026, 6, 27, 9, 30).getTime();
    }
    return 0;
  };

  const { deps, events } = baseDeps({ scan, spawnRun, now });
  await createDaemon(deps).tick();

  assert.deepEqual(spawnCalls, ['alpha']); // beta was never spawned.
  assert.ok(
    events.some((e) => e.event === 'slot-expired-skipped' && e.data?.profile === 'beta'),
  );

  const pidfile = readDaemonPidfile(deps.root, deps.pidfile);
  assert.deepEqual(
    pidfile?.attempts.map((a) => a.profile),
    ['alpha'], // beta was never ledgered — it was never attempted.
  );
});

test('two owed entries run sequentially in (slot, profileName) order', async () => {
  const scan = fakeScanDeps(
    {
      [profilePath('zeta')]: profileJson({ times: ['14:00'] }),
      [profilePath('alpha')]: profileJson({ times: ['14:00'] }),
    },
    { [PROFILES_DIR]: ['zeta', 'alpha'] },
  );

  const order: string[] = [];
  const spawnRun: SpawnRun = async (owed) => {
    order.push(`start:${owed.profile}`);
    await Promise.resolve();
    order.push(`end:${owed.profile}`);
    return 0;
  };

  const { deps } = baseDeps({ scan, spawnRun });
  await createDaemon(deps).tick();

  assert.deepEqual(order, ['start:alpha', 'end:alpha', 'start:zeta', 'end:zeta']);
});

test('the reentrancy guard short-circuits a tick BEFORE it rescans, while the heartbeat still runs', async () => {
  let nowMs = new Date(2026, 6, 27, 14, 4).getTime();
  const now = () => new Date(nowMs);

  const base = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  // Counting the profiles-dir readdir is what distinguishes "the guard
  // short-circuited" from "the batch ran again and found nothing owed" —
  // the ledger alone would mask a missing guard.
  let profileScans = 0;
  const scan: ScanDeps = {
    ...base,
    readdirSync: (p) => {
      if (p === PROFILES_DIR) profileScans += 1;
      return base.readdirSync(p);
    },
  };

  let resolveSpawn: ((code: number) => void) | undefined;
  const spawnRun: SpawnRun = () =>
    new Promise((resolve) => {
      resolveSpawn = resolve;
    });

  const { deps } = baseDeps({ scan, spawnRun, now });
  const daemon = createDaemon(deps);

  const firstTick = daemon.tick();
  await Promise.resolve();
  await Promise.resolve(); // let the heartbeat write and ledger append settle.
  assert.equal(profileScans, 1); // the first tick scanned once and is now in flight.

  const beforeSecondTick = readLastTickAt(deps);
  nowMs += 1000;
  await daemon.tick();

  assert.equal(profileScans, 1); // guard short-circuited BEFORE the rescan.
  assert.notEqual(readLastTickAt(deps), beforeSecondTick); // heartbeat still advanced.

  resolveSpawn?.(0);
  await firstTick;
});

test("yesterday's ledger entry does not serve today's identical slot", async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
    { [PROFILES_DIR]: ['harish'] }, // no run folders at all.
  );
  const spawnCalls: string[] = [];
  const spawnRun: SpawnRun = async (owed) => {
    spawnCalls.push(owed.profile);
    return 0;
  };
  const { deps } = baseDeps({ scan, spawnRun });

  // A stale attempt from the previous local day, same profile and slot.
  updateDaemonPidfile(
    deps.root,
    (current) => ({
      ...current,
      attempts: [{ profile: 'harish', date: '2026-07-26', slot: '14:00' }],
    }),
    deps.pidfile,
  );

  await createDaemon(deps).tick();

  assert.deepEqual(spawnCalls, ['harish']); // today's 14:00 is still owed.
});

test('appending an attempt prunes ledger entries from other days', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  const { deps } = baseDeps({ scan });

  updateDaemonPidfile(
    deps.root,
    (current) => ({
      ...current,
      attempts: [{ profile: 'harish', date: '2026-07-26', slot: '14:00' }],
    }),
    deps.pidfile,
  );

  await createDaemon(deps).tick();

  // Rollover clearing IS the append's own prune — no separate job.
  assert.deepEqual(readDaemonPidfile(deps.root, deps.pidfile)?.attempts, [
    { profile: 'harish', date: '2026-07-27', slot: '14:00' },
  ]);
});

test('revalidation measures grace from the entry OWN date, so a past-midnight batch skips a stale entry', async () => {
  let nowMs = new Date(2026, 6, 27, 23, 55).getTime();
  const now = () => new Date(nowMs);

  const scan = fakeScanDeps(
    {
      // Both slots are inside their grace window at 23:55, so both enter
      // the same batch: alpha 23:00+90m ends 00:30, beta 23:50+90m ends 01:20.
      [profilePath('alpha')]: profileJson({ times: ['23:00'], graceMinutes: 90 }),
      [profilePath('beta')]: profileJson({ times: ['23:50'], graceMinutes: 90 }),
    },
    { [PROFILES_DIR]: ['alpha', 'beta'] },
  );

  const spawnCalls: string[] = [];
  const spawnRun: SpawnRun = async (owed) => {
    spawnCalls.push(owed.profile);
    if (owed.profile === 'alpha') {
      // alpha runs overnight; beta's turn comes the NEXT calendar day.
      nowMs = new Date(2026, 6, 28, 9, 0).getTime();
    }
    return 0;
  };

  const { deps, events } = baseDeps({ scan, spawnRun, now });
  await createDaemon(deps).tick();

  // beta's own window (2026-07-27 23:50 -> 2026-07-28 01:20) is long past.
  // Measuring from now's date instead would compare against 2026-07-28
  // 23:50 and wrongly spawn it.
  assert.deepEqual(spawnCalls, ['alpha']);
  assert.ok(
    events.some((e) => e.event === 'slot-expired-skipped' && e.data?.profile === 'beta'),
  );
  assert.deepEqual(
    readDaemonPidfile(deps.root, deps.pidfile)?.attempts.map((a) => a.profile),
    ['alpha'],
  );
});

test('stop() during an in-flight child halts the batch: the NEXT owed entry is never spawned or ledgered', async () => {
  const scan = fakeScanDeps(
    {
      // Same slot, two profiles — one batch, alpha first (A13's
      // (slot, profileName) order), zeta queued behind it.
      [profilePath('alpha')]: profileJson({ times: ['14:00'] }),
      [profilePath('zeta')]: profileJson({ times: ['14:00'] }),
    },
    { [PROFILES_DIR]: ['alpha', 'zeta'] },
  );

  const spawnCalls: string[] = [];
  let resolveInFlight: ((code: number) => void) | undefined;
  const spawnRun: SpawnRun = (owed) => {
    spawnCalls.push(owed.profile);
    // Only the FIRST child is held pending; a second one (which is the
    // bug this pins) resolves immediately, so a regression fails on the
    // assertions below rather than hanging the suite on a promise whose
    // resolver was overwritten.
    if (spawnCalls.length > 1) return Promise.resolve(0);
    return new Promise((resolve) => {
      resolveInFlight = resolve;
    });
  };

  const { deps, events } = baseDeps({ scan, spawnRun });
  const daemon = createDaemon(deps);

  const ticking = daemon.tick();
  await Promise.resolve();
  await Promise.resolve(); // let the ledger append and first spawn settle.
  assert.deepEqual(spawnCalls, ['alpha']); // alpha in flight; zeta still queued.

  // SIGTERM lands while alpha is still running. `serve stop` kills the
  // daemon first and the in-flight child second, so alpha's own promise
  // still settles here — the hazard being closed is what happens NEXT.
  daemon.stop();
  resolveInFlight?.(0);
  await ticking;

  assert.deepEqual(spawnCalls, ['alpha']); // zeta was never spawned.
  assert.deepEqual(
    readDaemonPidfile(deps.root, deps.pidfile)?.attempts.map((a) => a.profile),
    ['alpha'], // and never ledgered — the slot stays genuinely unattempted.
  );
  assert.ok(
    events.some(
      (e) => e.event === 'stop-requested-batch-halted' && e.data?.profile === 'zeta',
    ),
  );
});

test('a tick that fires after stop() writes its heartbeat but opens no batch', async () => {
  const base = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  let profileScans = 0;
  const scan: ScanDeps = {
    ...base,
    readdirSync: (p) => {
      if (p === PROFILES_DIR) profileScans += 1;
      return base.readdirSync(p);
    },
  };
  const spawnCalls: string[] = [];
  const spawnRun: SpawnRun = async (owed) => {
    spawnCalls.push(owed.profile);
    return 0;
  };

  let nowMs = new Date(2026, 6, 27, 14, 4).getTime();
  const { deps } = baseDeps({ scan, spawnRun, now: () => new Date(nowMs) });
  const daemon = createDaemon(deps);

  daemon.stop();
  const beforeTick = readLastTickAt(deps);
  nowMs += 1000;
  await daemon.tick();

  assert.notEqual(readLastTickAt(deps), beforeTick); // A15.1: heartbeat still ran.
  assert.equal(profileScans, 0); // ...but the batch never opened.
  assert.deepEqual(spawnCalls, []);
});

test('a rejecting spawn does not escape the tick, and the next tick still runs', async () => {
  const base = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  let profileScans = 0;
  const scan: ScanDeps = {
    ...base,
    readdirSync: (p) => {
      if (p === PROFILES_DIR) profileScans += 1;
      return base.readdirSync(p);
    },
  };

  const spawnCalls: string[] = [];
  const spawnRun: SpawnRun = async (owed) => {
    spawnCalls.push(owed.profile);
    throw new Error('boom');
  };

  const { deps, events } = baseDeps({ scan, spawnRun });
  const daemon = createDaemon(deps);

  // A throwing batch must not reject out of what is, in production, a bare
  // setInterval callback — an unhandled rejection there kills the daemon.
  await assert.doesNotReject(() => daemon.tick());
  assert.ok(events.some((e) => e.event === 'tick-failed'));
  assert.deepEqual(spawnCalls, ['harish']);

  await assert.doesNotReject(() => daemon.tick());
  assert.equal(profileScans, 2); // the guard was released by the finally.
  assert.deepEqual(spawnCalls, ['harish']); // ledgered pre-spawn — not retried.
});
