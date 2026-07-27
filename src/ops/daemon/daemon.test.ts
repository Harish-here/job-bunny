import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProfileSchedule } from '../../core/schedule/index.ts';
import type { DaemonDeps, SpawnRun } from './daemon.ts';
import { createDaemon } from './daemon.ts';
import type { DaemonPidfileDeps } from './pidfile.ts';
import { acquireDaemonPidfile, readDaemonPidfile } from './pidfile.ts';
import type { ScanDeps } from './scan/index.ts';

const ROOT = '/fake/root';
const PROFILES_DIR = '/fake/profiles';

function profilePath(name: string): string {
  return join(PROFILES_DIR, name, 'profile.json');
}

function runsDirPath(name: string, date: string): string {
  return join(PROFILES_DIR, name, 'data', 'runs', date);
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
