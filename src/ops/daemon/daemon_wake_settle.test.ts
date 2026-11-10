/**
 * ops/daemon/daemon_wake_settle.test.ts — the wake-settle window: after a
 * suspend-sized gap the daemon keeps declining `host-asleep` until the host
 * has been continuously awake for WAKE_SETTLE_MS (180s). Regression: a macOS
 * maintenance DarkWake lasts 45-63s; the tick AFTER the declined wake tick saw
 * only a 30s gap, spawned inside the same DarkWake, and the run died when the
 * host slept again (2026-11-10: 4 decline->spawn pairs 30s apart).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDaemon } from './daemon.ts';
import { updateDaemonPidfile } from './pidfile.ts';
import {
  baseDeps,
  fakeScanDeps,
  PROFILES_DIR,
  profileJson,
  profilePath,
} from './testkit/index.ts';

const TICK = 30_000;
const WAKE_MS = new Date(2026, 6, 27, 14, 4).getTime(); // Monday 14:04, slot 14:00 owed.

function setLastTick(deps: ReturnType<typeof baseDeps>['deps'], atMs: number): void {
  updateDaemonPidfile(
    deps.root,
    (c) => ({ ...c, lastTickAt: new Date(atMs).toISOString() }),
    deps.pidfile,
  );
}

function slotRig() {
  const spawned: number[] = [];
  let nowMs = WAKE_MS;
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['14:00'], graceMinutes: 90 }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  const { deps, events } = baseDeps({
    scan,
    now: () => new Date(nowMs),
    spawnRun: async () => {
      spawned.push(nowMs);
      return 0;
    },
  });
  return {
    deps,
    events,
    spawned,
    advance: (ms: number) => (nowMs += ms),
    now: () => nowMs,
  };
}

test('owed slot: wake tick declines, +30s STILL declines (the regression), spawns once >=180s awake', async () => {
  const rig = slotRig();
  setLastTick(rig.deps, WAKE_MS - 15 * 60_000); // 15-min suspend gap.
  const daemon = createDaemon(rig.deps);

  await daemon.tick(); // wake tick.
  rig.advance(TICK);
  await daemon.tick(); // the old logic spawned here.
  assert.deepEqual(rig.spawned, [], '+30s after the wake must still decline');

  for (let i = 0; i < 4; i++) {
    rig.advance(TICK);
    await daemon.tick(); // +60s .. +150s
  }
  assert.deepEqual(rig.spawned, [], 'still inside the 180s settle window at +150s');
  assert.equal(
    rig.events.filter(
      (e) => e.event === 'gate-declined' && e.data?.reasonCode === 'host-asleep',
    ).length,
    6,
  );

  rig.advance(TICK); // +180s
  await daemon.tick();
  assert.deepEqual(rig.spawned, [WAKE_MS + 6 * TICK]);
});

test('owed slot: a new suspend-sized gap during settling resets the 180s window', async () => {
  const rig = slotRig();
  setLastTick(rig.deps, WAKE_MS - 15 * 60_000);
  const daemon = createDaemon(rig.deps);
  await daemon.tick(); // wake #1 at t0.
  rig.advance(TICK * 2);
  await daemon.tick(); // t0+60s, settling.

  // Host sleeps again for 10 minutes, wakes at t0+60s+10min.
  rig.advance(10 * 60_000);
  await daemon.tick(); // wake #2 — resets the window.
  const wake2 = rig.now();
  for (let i = 1; i <= 5; i++) {
    rig.advance(TICK);
    await daemon.tick();
  }
  assert.deepEqual(rig.spawned, [], 'wake #1 would have settled by now; wake #2 has not');

  rig.advance(TICK); // wake2 + 180s.
  await daemon.tick();
  assert.deepEqual(rig.spawned, [wake2 + 6 * TICK]);
});

test('catch-up path: wake tick declines, +30s STILL declines, spawnCatchup fires once >=180s awake', async () => {
  let nowMs = new Date(2026, 6, 27, 9, 30).getTime(); // 09:00 slot's grace long expired.
  const catchups: number[] = [];
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['09:00'], graceMinutes: 5 }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  const { deps } = baseDeps({
    scan,
    now: () => new Date(nowMs),
    spawnCatchup: async () => {
      catchups.push(nowMs);
      return 0;
    },
  });
  const wakeMs = nowMs;
  setLastTick(deps, wakeMs - 15 * 60_000);
  const daemon = createDaemon(deps);

  await daemon.tick(); // wake tick.
  nowMs += TICK;
  await daemon.tick(); // the old logic spawned the catch-up here.
  assert.deepEqual(catchups, [], '+30s after the wake must still decline');
  for (let i = 0; i < 4; i++) {
    nowMs += TICK;
    await daemon.tick();
  }
  assert.deepEqual(catchups, []);

  nowMs += TICK; // +180s
  await daemon.tick();
  assert.deepEqual(catchups, [wakeMs + 6 * TICK]);
  nowMs += TICK;
  await daemon.tick();
  assert.equal(catchups.length, 1, 'exactly one catch-up');
});

test('catch-up path: a new gap during settling resets the window', async () => {
  let nowMs = new Date(2026, 6, 27, 9, 30).getTime();
  const catchups: number[] = [];
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['09:00'], graceMinutes: 5 }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  const { deps } = baseDeps({
    scan,
    now: () => new Date(nowMs),
    spawnCatchup: async () => {
      catchups.push(nowMs);
      return 0;
    },
  });
  setLastTick(deps, nowMs - 15 * 60_000);
  const daemon = createDaemon(deps);
  await daemon.tick(); // wake #1.
  nowMs += TICK * 4;
  await daemon.tick(); // +120s, settling.
  nowMs += 10 * 60_000;
  await daemon.tick(); // wake #2 resets.
  const wake2 = nowMs;
  for (let i = 0; i < 5; i++) {
    nowMs += TICK;
    await daemon.tick();
  }
  assert.deepEqual(catchups, []);
  nowMs += TICK;
  await daemon.tick();
  assert.deepEqual(catchups, [wake2 + 6 * TICK]);
});

test('no suspend gap: behaviour is unchanged (spawns on the first tick, no settle delay)', async () => {
  const rig = slotRig();
  setLastTick(rig.deps, WAKE_MS - TICK);
  await createDaemon(rig.deps).tick();
  assert.deepEqual(rig.spawned, [WAKE_MS]);
});
