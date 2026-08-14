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

test('(f) a catch-up-only tick (no owed entries at all) still runs the reachability probe and declines on it — R2 must cover the catch-up path too', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['09:00'], graceMinutes: 5 }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  const now = new Date(2026, 6, 27, 9, 30); // grace (09:00-09:05) already expired.
  const notifyCalls: string[] = [];
  const spawnCatchupCalls: number[] = [];
  let probed = 0;
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
    probeReachable: async () => {
      probed += 1;
      return false; // the genuine network-decline case (finding: previously
      // unreachable per this test's own gap, since `hasOwedEntries` was
      // `sorted.length > 0` — always false on a catch-up-only tick, so the
      // probe never ran and only a forced suspend-gap could decline this
      // tick at all).
    },
  });
  // No owed entries this tick (09:00's own grace already closed) — only a
  // catch-up candidate exists. `lastTickAt` is left fresh (no suspend gap)
  // so ONLY the reachability probe below can decline the gate.

  await createDaemon(deps).tick();

  assert.equal(probed, 1, 'the probe must fire even with zero owed entries this tick');
  assert.equal(notifyCalls.length, 1); // message and spawn are decoupled.
  assert.equal(spawnCatchupCalls.length, 0);
  assert.ok(
    events.some(
      (e) =>
        e.event === 'gate-declined' &&
        e.data?.slot === 'catchup' &&
        e.data?.reasonCode === 'network-unreachable',
    ),
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

// step 1.11a (coordinator-added) — the retrospective, past-day sweep: a lid
// that stays closed for a WHOLE calendar day means step 1.11's own live T4/
// catch-up mechanism never runs for that day at all (it only ever evaluates
// `today`). `weekdays: []` keeps `harish` OUT of today's own live per-entry
// loop and deferred sweep in every case below, so only the new retrospective
// loop is under test.

test('1.11a(a): 5 unnotified deferred rows dated yesterday, no catchup run that date -> exactly one no-catchup-variant notify, and markNotified called once for that date', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['09:00'], weekdays: [] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  const notifyCalls: string[] = [];
  const { deps } = baseDeps({
    scan,
    now: () => new Date(MONDAY_14_04), // today = 2026-07-27.
    notify: async (_profile, event) => {
      notifyCalls.push(event.text);
      return true;
    },
    hasCatchupRun: () => false,
  });
  let markNotifiedCalls = 0;
  const realMarkNotified = deps.markNotified;
  deps.markNotified = (profile, runDate, notifiedAt) => {
    markNotifiedCalls += 1;
    realMarkNotified(profile, runDate, notifiedAt);
  };
  for (let i = 0; i < 5; i++) {
    deps.recordDeferral('harish', {
      runDate: '2026-07-26',
      slot: `0${9 + i}:00`,
      reasonCode: 'host-asleep',
      reason: 'asleep',
      decidedAt: '2026-07-26T20:00:00.000Z',
    });
  }

  await createDaemon(deps).tick();

  assert.equal(notifyCalls.length, 1);
  assert.match(notifyCalls[0] ?? '', /Next scheduled slot:/);
  assert.doesNotMatch(notifyCalls[0] ?? '', /Catch-up run starting now/);
  assert.equal(markNotifiedCalls, 1);
  assert.ok(deps.listForDate('harish', '2026-07-26').every((r) => r.notifiedAt !== null));
});

test('1.11a(b): repeated ticks after the date is covered send zero further notify calls (idempotent via notifiedAt) — call COUNT stays at 1', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['09:00'], weekdays: [] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  let nowMs = new Date(MONDAY_14_04).getTime();
  const notifyCalls: string[] = [];
  const { deps } = baseDeps({
    scan,
    now: () => new Date(nowMs),
    notify: async (_profile, event) => {
      notifyCalls.push(event.text);
      return true;
    },
    hasCatchupRun: () => false,
  });
  deps.recordDeferral('harish', {
    runDate: '2026-07-26',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'asleep',
    decidedAt: '2026-07-26T20:00:00.000Z',
  });
  const daemon = createDaemon(deps);

  for (let i = 0; i < 6; i++) {
    await daemon.tick();
    nowMs += 30_000;
  }

  assert.equal(notifyCalls.length, 1);
});

test("1.11a(c): yesterday DID have a kind:'catchup' run -> zero notify calls, but markNotified is still called once (so the query stays empty going forward)", async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['09:00'], weekdays: [] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  const notifyCalls: string[] = [];
  const { deps } = baseDeps({
    scan,
    now: () => new Date(MONDAY_14_04),
    notify: async (_profile, event) => {
      notifyCalls.push(event.text);
      return true;
    },
    hasCatchupRun: (profile, date) => profile === 'harish' && date === '2026-07-26',
  });
  deps.recordDeferral('harish', {
    runDate: '2026-07-26',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'asleep',
    decidedAt: '2026-07-26T20:00:00.000Z',
  });

  await createDaemon(deps).tick();

  assert.equal(notifyCalls.length, 0);
  assert.ok(
    deps.listForDate('harish', '2026-07-26').every((r) => r.notifiedAt !== null),
    'markNotified must still run so the query stays empty going forward',
  );
});

test('1.11a(d): two distinct past unnotified dates produce exactly two notify calls, one per date', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['09:00'], weekdays: [] }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  const notifyCalls: string[] = [];
  const { deps } = baseDeps({
    scan,
    now: () => new Date(MONDAY_14_04),
    notify: async (_profile, event) => {
      notifyCalls.push(event.text);
      return true;
    },
    hasCatchupRun: () => false,
  });
  deps.recordDeferral('harish', {
    runDate: '2026-07-25',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'asleep',
    decidedAt: '2026-07-25T20:00:00.000Z',
  });
  deps.recordDeferral('harish', {
    runDate: '2026-07-26',
    slot: '09:00',
    reasonCode: 'network-unreachable',
    reason: 'no network',
    decidedAt: '2026-07-26T20:00:00.000Z',
  });

  await createDaemon(deps).tick();

  assert.equal(notifyCalls.length, 2);
  assert.ok(deps.listForDate('harish', '2026-07-25').every((r) => r.notifiedAt !== null));
  assert.ok(deps.listForDate('harish', '2026-07-26').every((r) => r.notifiedAt !== null));
});

// Bug 1 (pipeline-stability-hardening QA, 2026-08-14) — the spec's OWN
// worked example: the host is asleep across every one of today's 5 slots,
// wakes at 20:12. Before the fix, every one of the 5 deferred rows read
// `daemon-unavailable` ("the scheduler was not running during today's
// scheduled window") — the wrong diagnosis, since the daemon PROCESS never
// stopped; the HOST was asleep. All 5 rows must read `host-asleep`, and
// T4's own text must say so.

test('bug 1 (the canonical lid-closed day): host asleep across all 5 slots, wakes 20:12 — every deferred row reads host-asleep, and T4 says the host was asleep, not that the scheduler was not running', async () => {
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
  const { deps } = baseDeps({
    scan,
    now: () => new Date(2026, 6, 27, 20, 12), // wakes 20:12 — well past every slot's grace.
    notify: async (_profile, event) => {
      notifyCalls.push(event.text);
      return true;
    },
  });
  // The host slept from before 09:00 straight through to 20:12 — the
  // daemon process itself never ticked in between, so `lastTickAt` is
  // still whatever it was at the very start of that window (well before
  // 09:00), producing a gap far past SUSPECTED_SUSPEND_GAP_MS on THIS,
  // the very first tick since.
  updateDaemonPidfile(
    deps.root,
    (c) => ({ ...c, lastTickAt: new Date(2026, 6, 27, 8, 0).toISOString() }),
    deps.pidfile,
  );

  await createDaemon(deps).tick();

  const rows = deps.listForDate('harish', '2026-07-27');
  assert.equal(rows.length, 5);
  assert.ok(
    rows.every((r) => r.reasonCode === 'host-asleep'),
    `expected every row to read host-asleep, got: ${rows.map((r) => r.reasonCode).join(', ')}`,
  );
  assert.equal(notifyCalls.length, 1);
  const text = notifyCalls[0] ?? '';
  assert.ok(text.includes('because the host'), text);
  assert.ok(text.includes('was asleep'), text);
  assert.ok(!text.includes('scheduler was not running'), text);
});

// Bug 7 (pipeline-stability-hardening QA, 2026-08-14) — a catch-up-only
// tick (no real owed slot entries, only a lingering expired catch-up
// candidate) used to re-probe DNS and re-log `gate-declined` on EVERY 30s
// tick for as long as the catch-up stayed gate-declined (measured: 240
// ticks -> 240 log lines and 240 DNS probes). Both must now be bounded to
// at most once per hour.

test('bug 7 (log only) / bug 8 (decision): a catch-up-only tick that stays gate-declined re-probes DNS EVERY tick, but re-logs gate-declined at most once per hour', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['09:00'], graceMinutes: 5 }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  let nowMs = new Date(2026, 6, 27, 9, 30).getTime(); // grace (09:00-09:05) already expired.
  let probed = 0;
  const { deps, events } = baseDeps({
    scan,
    now: () => new Date(nowMs),
    probeReachable: async () => {
      probed += 1;
      return false; // stays unreachable throughout.
    },
  });
  const daemon = createDaemon(deps);

  // 6 ticks, 30s apart — well within the 1-hour LOG throttle window.
  for (let i = 0; i < 6; i++) {
    await daemon.tick();
    nowMs += 30_000;
  }
  assert.equal(
    probed,
    6,
    'bug 8: the gate DECISION must be recomputed (re-probed) on every single tick — never served from cache',
  );
  assert.equal(
    events.filter((e) => e.event === 'gate-declined' && e.data?.slot === 'catchup')
      .length,
    1,
    'bug 7: the LOG line stays latched to at most once per hour',
  );

  // Advance PAST the 1-hour LOG throttle window in steps small enough
  // (100s < SUSPECTED_SUSPEND_GAP_MS's 2 minutes) that no individual tick
  // trips the SUSPEND detector — this exercises the reachability-PROBE
  // retry path specifically, not a suspected-suspend one.
  for (let i = 0; i < 40; i++) {
    await daemon.tick();
    nowMs += 100_000;
  }
  assert.equal(probed, 46, 'every one of the 46 ticks probes fresh');
  assert.equal(
    events.filter((e) => e.event === 'gate-declined' && e.data?.slot === 'catchup')
      .length,
    2,
    'the log fires again once the 1h window elapses, still bounded (not per-tick)',
  );
});

test('bug 8 (CRITICAL): once the network recovers, the very NEXT tick spawns the catch-up — a transient decline costs one tick, never an hour (AC4)', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['09:00'], graceMinutes: 5 }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  let nowMs = new Date(2026, 6, 27, 9, 30).getTime();
  let probed = 0;
  let reachable = false;
  const spawnCatchupCalls: number[] = [];
  const { deps } = baseDeps({
    scan,
    now: () => new Date(nowMs),
    probeReachable: async () => {
      probed += 1;
      return reachable;
    },
    spawnCatchup: async () => {
      spawnCatchupCalls.push(1);
      return 0;
    },
  });
  const daemon = createDaemon(deps);

  await daemon.tick(); // declined, network down.
  assert.equal(probed, 1);
  assert.equal(spawnCatchupCalls.length, 0);

  // Network recovers 30 SECONDS later — a probe blip, not an hour-long
  // outage. The old (bug 8) behavior kept honoring an already-declined
  // cache for up to an hour; the fix must spawn on this very next tick.
  reachable = true;
  nowMs += 30_000;
  await daemon.tick();

  assert.equal(probed, 2, 'the very next tick must probe fresh, not reuse the cache');
  assert.equal(
    spawnCatchupCalls.length,
    1,
    'the catch-up must spawn on the tick immediately after recovery, not an hour later',
  );
});

test('bug 8 (CRITICAL): first tick suspend-declined, second tick healthy -> spawnCatchup fires exactly once, on the second tick (AC9/AC10 had no test asserting this before bug 8 shipped)', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['09:00'], graceMinutes: 5 }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  let nowMs = new Date(2026, 6, 27, 9, 30).getTime(); // grace already expired -> catch-up-only tick.
  const spawnCatchupCalls: number[] = [];
  const { deps } = baseDeps({
    scan,
    now: () => new Date(nowMs),
    probeReachable: async () => true, // reachable — only the suspend gap can decline tick 1.
    spawnCatchup: async () => {
      spawnCatchupCalls.push(1);
      return 0;
    },
  });
  // Simulate a suspend gap ahead of the FIRST tick only — the lid was
  // closed, the host woke, and this daemon process's very first tick since
  // waking fires now. Exactly the branch bug 8's cache was most often
  // populated by, per the QA report's own note.
  updateDaemonPidfile(
    deps.root,
    (c) => ({ ...c, lastTickAt: new Date(nowMs - 5 * 60_000).toISOString() }),
    deps.pidfile,
  );
  const daemon = createDaemon(deps);

  await daemon.tick(); // tick 1: suspend-declined -> no spawn, no ledger.
  assert.equal(spawnCatchupCalls.length, 0);

  nowMs += 30_000; // 30s later — the gap since tick 1 is small; no longer suspected.
  await daemon.tick(); // tick 2: healthy -> spawns.

  assert.equal(
    spawnCatchupCalls.length,
    1,
    'exactly one catch-up, spawned on the SECOND tick — not delayed an hour, not lost',
  );
});

test('bug 8 (CRITICAL): waking at 23:30 with unserved expired slots spawns the catch-up the SAME day, count 1 — the day must never be lost to a stale cache outliving the date', async () => {
  const scan = fakeScanDeps(
    { [profilePath('harish')]: profileJson({ times: ['19:00'], graceMinutes: 5 }) },
    { [PROFILES_DIR]: ['harish'] },
  );
  // 2026-07-27 23:30 — well past 19:00's grace window; the lid has been
  // closed the whole day (a large gap since the last real tick).
  let nowMs = new Date(2026, 6, 27, 23, 30).getTime();
  const spawnCatchupCalls: number[] = [];
  const { deps } = baseDeps({
    scan,
    now: () => new Date(nowMs),
    probeReachable: async () => true,
    spawnCatchup: async () => {
      spawnCatchupCalls.push(1);
      return 0;
    },
  });
  updateDaemonPidfile(
    deps.root,
    (c) => ({ ...c, lastTickAt: new Date(nowMs - 10 * 60 * 60_000).toISOString() }), // 10h gap.
    deps.pidfile,
  );
  const daemon = createDaemon(deps);

  await daemon.tick(); // wake tick: suspend-declined.
  assert.equal(spawnCatchupCalls.length, 0);

  nowMs += 30_000; // the very next scheduled tick, still 2026-07-27.
  await daemon.tick();

  assert.equal(
    spawnCatchupCalls.length,
    1,
    'the old (bug 8) cache would have blocked this for up to an hour — long enough, at a ' +
      '23:30 wake, to survive past midnight and lose the day entirely',
  );
});
