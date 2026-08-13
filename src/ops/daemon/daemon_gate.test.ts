/**
 * ops/daemon/daemon_gate.test.ts — task 12's own suite (blueprint step
 * 1.11: the suspend/reachability gate, the deferred sweep, and the
 * same-day catch-up decision), split into its own colocated file for the
 * same file-size-cap reason `daemon_schema_drift.test.ts` was (see that
 * file's own doc comment, and `testkit/fixtures.ts`'s).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDaemon } from './daemon.ts';
import { readDaemonPidfile, updateDaemonPidfile } from './pidfile.ts';
import {
  baseDeps,
  fakeScanDeps,
  PROFILES_DIR,
  profileJson,
  profilePath,
} from './testkit/index.ts';

const MONDAY_14_04 = new Date(2026, 6, 27, 14, 4).getTime(); // 2026-07-27 is a Monday.

test('(a) a suspend-gap tick declines every owed entry: no spawn, no ledger write', async () => {
  const spawnCalls: string[] = [];
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  const { deps, events } = baseDeps({
    scan,
    now: () => new Date(MONDAY_14_04),
    spawnRun: async (owed) => {
      spawnCalls.push(owed.profile);
      return 0;
    },
  });
  // Simulate a suspend gap: the pidfile's own lastTickAt is 5 minutes
  // stale relative to `now` — well past SUSPECTED_SUSPEND_GAP_MS (2min).
  updateDaemonPidfile(
    deps.root,
    (c) => ({ ...c, lastTickAt: new Date(MONDAY_14_04 - 5 * 60_000).toISOString() }),
    deps.pidfile,
  );

  await createDaemon(deps).tick();

  assert.deepEqual(spawnCalls, []);
  assert.deepEqual(
    readDaemonPidfile(deps.root, deps.pidfile)?.attempts.map((a) => a.profile),
    [], // R3/AC3 — no ledger entry for a gated slot.
  );
  assert.ok(
    events.some(
      (e) =>
        e.event === 'gate-declined' &&
        e.data?.profile === 'harish' &&
        e.data?.reasonCode === 'host-asleep',
    ),
  );
  assert.equal(
    readDaemonPidfile(deps.root, deps.pidfile)?.lastGateDecline?.reasonCode,
    'host-asleep',
  );
});

test('(b) a reachable, non-suspended tick behaves exactly as today (regression)', async () => {
  const spawnCalls: string[] = [];
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['14:00'] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  let probed = 0;
  const { deps } = baseDeps({
    scan,
    now: () => new Date(MONDAY_14_04),
    spawnRun: async (owed) => {
      spawnCalls.push(owed.profile);
      return 0;
    },
    probeReachable: async () => {
      probed += 1;
      return true;
    },
  });
  updateDaemonPidfile(
    deps.root,
    (c) => ({ ...c, lastTickAt: new Date(MONDAY_14_04 - 10_000).toISOString() }),
    deps.pidfile,
  );

  await createDaemon(deps).tick();

  assert.deepEqual(spawnCalls, ['harish']);
  assert.equal(probed, 1); // probed at most once, since there WAS an owed entry.
  assert.deepEqual(
    readDaemonPidfile(deps.root, deps.pidfile)?.attempts.map((a) => a.profile),
    ['harish'],
  );
});

test('(c) a day with 5 expired-unserved slots: exactly 5 deferred_slots rows, one T4, one spawnCatchup', async () => {
  const scan = fakeScanDeps(
    {
      [profilePath('harish')]: profileJson({
        times: ['09:00', '11:30', '14:00', '16:30', '19:00'],
        graceMinutes: 30,
      }),
    },
    { [PROFILES_DIR]: ['harish'] },
  );
  const notifyCalls: string[] = [];
  const spawnCatchupCalls: Array<{ standingInFor: readonly string[] }> = [];
  const { deps } = baseDeps({
    scan,
    now: () => new Date(2026, 6, 27, 20, 0), // well past every slot's 30-min grace.
    notify: async (_profile, event) => {
      notifyCalls.push(event.text);
      return true;
    },
    spawnCatchup: async (target) => {
      spawnCatchupCalls.push(target);
      return 0;
    },
  });

  await createDaemon(deps).tick();

  assert.equal(deps.listForDate('harish', '2026-07-27').length, 5);
  assert.equal(notifyCalls.length, 1);
  assert.match(notifyCalls[0] ?? '', /Catch-up run starting now/);
  assert.equal(spawnCatchupCalls.length, 1);
  assert.deepEqual(spawnCatchupCalls[0]?.standingInFor, [
    '09:00',
    '11:30',
    '14:00',
    '16:30',
    '19:00',
  ]);
});

test('(d) many further ticks the same day, after T4 + catch-up already recorded, send nothing more (call COUNTS stay at 1)', async () => {
  const scan = fakeScanDeps(
    {
      [profilePath('harish')]: profileJson({
        times: ['09:00', '11:30', '14:00', '16:30', '19:00'],
        graceMinutes: 30,
      }),
    },
    { [PROFILES_DIR]: ['harish'] },
  );
  let nowMs = new Date(2026, 6, 27, 20, 0).getTime();
  const notifyCalls: string[] = [];
  const spawnCatchupCalls: number[] = [];
  const { deps } = baseDeps({
    scan,
    now: () => new Date(nowMs),
    notify: async () => {
      notifyCalls.push('x');
      return true;
    },
    spawnCatchup: async () => {
      spawnCatchupCalls.push(1);
      return 0;
    },
  });
  const daemon = createDaemon(deps);

  for (let i = 0; i < 12; i++) {
    await daemon.tick();
    nowMs += 30_000; // simulate the real 30s tick cadence.
  }

  assert.equal(notifyCalls.length, 1); // latched by deferred_slots.notifiedAt.
  assert.equal(spawnCatchupCalls.length, 1); // latched by the pidfile attempts ledger.
});

test('(e) a failed catch-up (nonzero exit) is not retried later the same day', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['09:00'], graceMinutes: 5 }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  let nowMs = new Date(2026, 6, 27, 9, 30).getTime(); // grace (09:00-09:05) already expired.
  const spawnCatchupCalls: number[] = [];
  const { deps } = baseDeps({
    scan,
    now: () => new Date(nowMs),
    spawnCatchup: async () => {
      spawnCatchupCalls.push(1);
      return 1; // nonzero — "the catch-up run itself failed."
    },
  });
  const daemon = createDaemon(deps);

  await daemon.tick();
  nowMs += 30_000;
  await daemon.tick();
  nowMs += 30_000;
  await daemon.tick();

  assert.equal(spawnCatchupCalls.length, 1); // ledgered before spawn, regardless of exit code.
});

test('(f) a tick where the gate declines the catch-up spawn itself still sends exactly one T4', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['09:00'], graceMinutes: 5 }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  const now = new Date(2026, 6, 27, 9, 30); // grace (09:00-09:05) already expired.
  const notifyCalls: string[] = [];
  const spawnCatchupCalls: number[] = [];
  const { deps, events } = baseDeps({
    scan,
    now: () => now,
    notify: async () => {
      notifyCalls.push('x');
      return true;
    },
    spawnCatchup: async () => {
      spawnCatchupCalls.push(1);
      return 0;
    },
  });
  // No owed entries this tick (09:00's own grace already closed), so only
  // `wasHostSuspended` (pure, no probe) can decline the gate — force it.
  updateDaemonPidfile(
    deps.root,
    (c) => ({ ...c, lastTickAt: new Date(now.getTime() - 5 * 60_000).toISOString() }),
    deps.pidfile,
  );

  await createDaemon(deps).tick();

  assert.equal(notifyCalls.length, 1); // message and spawn are decoupled.
  assert.equal(spawnCatchupCalls.length, 0);
  assert.ok(
    events.some((e) => e.event === 'gate-declined' && e.data?.slot === 'catchup'),
  );
  assert.deepEqual(
    (readDaemonPidfile(deps.root, deps.pidfile)?.attempts ?? []).filter(
      (a) => a.slot === 'catchup',
    ),
    [], // never ledgered while gated.
  );
});

test('trap 4: a slot gated on many ticks within its grace window produces zero deferred_slots rows until grace fully expires', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['09:00'], graceMinutes: 10 }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  let nowMs = new Date(2026, 6, 27, 9, 1).getTime(); // inside the 09:00-09:10 grace window.
  const { deps } = baseDeps({ scan, now: () => new Date(nowMs) });
  const daemon = createDaemon(deps);

  // Every tick within the grace window is (re-)declared stale enough to
  // suspend-gate — simulating a host that stays asleep across many ticks.
  for (let i = 0; i < 6; i++) {
    updateDaemonPidfile(
      deps.root,
      (c) => ({ ...c, lastTickAt: new Date(nowMs - 5 * 60_000).toISOString() }),
      deps.pidfile,
    );
    await daemon.tick();
    assert.deepEqual(
      deps.listForDate('harish', '2026-07-27'),
      [], // gated, still within grace — the deferred sweep has nothing to find yet.
    );
    nowMs += 60_000;
  }

  // Now past the grace window (09:10) — the deferred sweep finds it.
  nowMs = new Date(2026, 6, 27, 9, 15).getTime();
  await daemon.tick();
  assert.equal(deps.listForDate('harish', '2026-07-27').length, 1);
});

test('trap 5: the catch-up fires even when earlier slots the same day already succeeded (no suppression)', async () => {
  const scan = fakeScanDeps(
    {
      [profilePath('harish')]: profileJson({
        times: ['09:00', '11:30', '14:00', '16:30', '19:00'],
        graceMinutes: 30,
      }),
    },
    { [PROFILES_DIR]: ['harish'] },
  );
  const spawnCatchupCalls: Array<{ standingInFor: readonly string[] }> = [];
  const { deps } = baseDeps({
    scan,
    now: () => new Date(2026, 6, 27, 20, 0),
    // 09:00 and 11:30 already ran and succeeded (real durable evidence).
    readRunHistory: () => [
      { profile: 'harish', date: '2026-07-27', startedAt: '09:00' },
      { profile: 'harish', date: '2026-07-27', startedAt: '11:30' },
    ],
    spawnCatchup: async (target) => {
      spawnCatchupCalls.push(target);
      return 0;
    },
  });

  await createDaemon(deps).tick();

  assert.equal(spawnCatchupCalls.length, 1); // fires regardless of the two earlier successes.
  assert.deepEqual(spawnCatchupCalls[0]?.standingInFor, ['14:00', '16:30', '19:00']);
});
