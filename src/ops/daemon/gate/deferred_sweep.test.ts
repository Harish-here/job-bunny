import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProfileSchedule, RunRecord } from '../../../core/schedule/index.ts';
import { deriveExpiredUnserved } from '../../../core/schedule/index.ts';
import {
  acquireDaemonPidfile,
  readDaemonPidfile,
  updateDaemonPidfile,
} from '../pidfile.ts';
import { fakeDeferredSlotStore, fakePidfileDeps, ROOT } from '../testkit/index.ts';
import {
  runDeferredSweepAndCatchup,
  runRetrospectiveDeferredSweep,
} from './deferred_sweep.ts';
import type { ReachabilityGateDecision } from './reachability_gate.ts';

const NOW = new Date(2026, 6, 27, 20, 0); // 2026-07-27 20:00, well past every slot's grace.

const SCHEDULE: ProfileSchedule = {
  profile: 'harish',
  enabled: true,
  times: ['09:00', '11:30', '14:00', '16:30', '19:00'],
  weekdays: [1, 2, 3, 4, 5],
  graceMinutes: 30,
};

const OPEN_GATE: ReachabilityGateDecision = {
  declined: false,
  reasonCode: null,
  reason: null,
};
const CLOSED_GATE: ReachabilityGateDecision = {
  declined: true,
  reasonCode: 'host-asleep',
  reason: 'Job Bunny declined to start this run because the host was asleep.',
};

/** Mirrors the caller's own (`daemon.ts`) derivation, since the function
 * under test no longer derives candidates itself — see this file's own
 * doc comment. */
function candidatesFor(
  now: Date,
  schedules: readonly ProfileSchedule[],
  history: readonly RunRecord[],
) {
  return deriveExpiredUnserved(now, schedules, history);
}

function buildDeps(
  overrides: {
    notify?: (profile: string, event: { text: string }) => Promise<boolean>;
    spawnCatchup?: (target: {
      profile: string;
      standingInFor: readonly string[];
    }) => Promise<number>;
    hasCatchupRun?: (profile: string, date: string) => boolean;
  } = {},
): {
  deps: Parameters<typeof runDeferredSweepAndCatchup>[0];
  pidfile: ReturnType<typeof fakePidfileDeps>;
  deferred: ReturnType<typeof fakeDeferredSlotStore>;
  events: Array<{ event: string; data?: Record<string, unknown> }>;
} {
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile(ROOT, 1, pidfile);
  const deferred = fakeDeferredSlotStore();
  const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const deps = {
    root: ROOT,
    pidfile,
    recordDeferral: deferred.recordDeferral,
    listForDate: deferred.listForDate,
    listUnnotifiedDatesBefore: deferred.listUnnotifiedDatesBefore,
    markNotified: deferred.markNotified,
    notify: overrides.notify ?? (async () => true),
    // No prior catch-up run by default — the same posture as
    // `testkit/fixtures.ts`'s `baseDeps`; only the R8-restart test below
    // overrides this.
    hasCatchupRun: overrides.hasCatchupRun ?? (() => false),
    spawnCatchup: overrides.spawnCatchup ?? (async () => 0),
    log: (event: string, data?: Record<string, unknown>) => events.push({ event, data }),
  };
  return { deps, pidfile, deferred, events };
}

test('runDeferredSweepAndCatchup: 5 expired-unserved slots produce exactly 5 rows, one notify, one spawnCatchup', async () => {
  const notifyCalls: string[] = [];
  const spawnCalls: Array<{ profile: string; standingInFor: readonly string[] }> = [];
  const { deps, deferred } = buildDeps({
    notify: async (profile) => {
      notifyCalls.push(profile);
      return true;
    },
    spawnCatchup: async (target) => {
      spawnCalls.push(target);
      return 0;
    },
  });

  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [SCHEDULE], []),
    OPEN_GATE,
  );

  assert.equal(deferred.rows.get('harish')?.length, 5);
  assert.equal(notifyCalls.length, 1);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0]?.standingInFor, [
    '09:00',
    '11:30',
    '14:00',
    '16:30',
    '19:00',
  ]);
});

test('runDeferredSweepAndCatchup: fires even when earlier slots the same day already succeeded (no suppression)', async () => {
  const spawnCalls: Array<{ standingInFor: readonly string[] }> = [];
  const { deps, deferred } = buildDeps({
    spawnCatchup: async (target) => {
      spawnCalls.push(target);
      return 0;
    },
  });
  const history: RunRecord[] = [
    { profile: 'harish', date: '2026-07-27', startedAt: '09:00' },
    { profile: 'harish', date: '2026-07-27', startedAt: '11:30' },
  ];

  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [SCHEDULE], history),
    OPEN_GATE,
  );

  assert.deepEqual(
    deferred.rows.get('harish')?.map((r) => r.slot),
    ['14:00', '16:30', '19:00'],
  );
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0]?.standingInFor, ['14:00', '16:30', '19:00']);
});

test('runDeferredSweepAndCatchup: a second call the same day, after T4+catch-up already recorded, sends nothing further — even across many calls', async () => {
  const notifyCalls: string[] = [];
  const spawnCalls: number[] = [];
  const { deps } = buildDeps({
    notify: async (profile) => {
      notifyCalls.push(profile);
      return true;
    },
    spawnCatchup: async () => {
      spawnCalls.push(1);
      return 0;
    },
  });

  for (let i = 0; i < 8; i++) {
    await runDeferredSweepAndCatchup(
      deps,
      NOW,
      '2026-07-27',
      candidatesFor(NOW, [SCHEDULE], []),
      OPEN_GATE,
    );
  }

  assert.equal(notifyCalls.length, 1);
  assert.equal(spawnCalls.length, 1);
});

test('runDeferredSweepAndCatchup: a failed catch-up (nonzero exit) is not retried later the same day', async () => {
  const spawnCalls: number[] = [];
  const { deps } = buildDeps({
    spawnCatchup: async () => {
      spawnCalls.push(1);
      return 1; // nonzero — "failed."
    },
  });

  for (let i = 0; i < 3; i++) {
    await runDeferredSweepAndCatchup(
      deps,
      NOW,
      '2026-07-27',
      candidatesFor(NOW, [SCHEDULE], []),
      OPEN_GATE,
    );
  }

  assert.equal(spawnCalls.length, 1); // ledgered before spawn regardless of outcome.
});

test('runDeferredSweepAndCatchup: a gate-declined catch-up still sends exactly one T4, but never ledgers or spawns', async () => {
  const notifyCalls: string[] = [];
  const spawnCalls: number[] = [];
  const { deps, pidfile, events } = buildDeps({
    notify: async (profile) => {
      notifyCalls.push(profile);
      return true;
    },
    spawnCatchup: async () => {
      spawnCalls.push(1);
      return 0;
    },
  });

  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [SCHEDULE], []),
    CLOSED_GATE,
  );

  assert.equal(notifyCalls.length, 1); // message and spawn are decoupled.
  assert.equal(spawnCalls.length, 0);
  assert.ok(
    events.some((e) => e.event === 'gate-declined' && e.data?.slot === 'catchup'),
  );
  const current = readDaemonPidfile(ROOT, pidfile);
  assert.deepEqual(
    (current?.attempts ?? []).filter((a) => a.slot === 'catchup'),
    [], // never ledgered while gated — retries next call once the gate clears.
  );
});

test('runDeferredSweepAndCatchup: recordDeferral is called only here — never simulated by a gated owed-entry pass (Trap 4 boundary check)', async () => {
  // No candidates at all (nothing expired yet) — a no-op call must never
  // write any deferred_slots rows, regardless of gate state.
  const { deps, deferred } = buildDeps();
  const schedule: ProfileSchedule = { ...SCHEDULE, times: ['19:55'], graceMinutes: 30 };
  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [schedule], []),
    CLOSED_GATE,
  );
  assert.deepEqual(deferred.rows.get('harish') ?? [], []);
});

test("runDeferredSweepAndCatchup (bug 1): a candidate with a per-slot slotGateDeclines entry is attributed to THAT slot's own reason, not the live gate", async () => {
  const { deps, pidfile, deferred } = buildDeps();
  // Seeds exactly what `applyGateDecline` itself would have written on a
  // tick where 09:00 was still owed (within grace) and gate-declined —
  // see reachability_gate.test.ts's own upsert test for that half.
  updateDaemonPidfile(
    ROOT,
    (current) => ({
      ...current,
      slotGateDeclines: [
        {
          profile: 'harish',
          date: '2026-07-27',
          slot: '09:00',
          reasonCode: 'network-unreachable',
          reason:
            'Job Bunny declined to start this run because the network was unreachable.',
          at: new Date(2026, 6, 27, 9, 15).toISOString(),
        },
      ],
    }),
    pidfile,
  );
  const schedule: ProfileSchedule = { ...SCHEDULE, times: ['09:00'], graceMinutes: 30 };
  // The LIVE gate this tick is OPEN (host awake, network fine by 20:00) —
  // proof the per-slot record, not the current tick's own gate reading,
  // drives the attribution.
  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [schedule], []),
    OPEN_GATE,
  );
  assert.equal(deferred.rows.get('harish')?.[0]?.reasonCode, 'network-unreachable');
});

test('runDeferredSweepAndCatchup (bug 1): no slotGateDeclines entry and an open gate falls back to daemon-unavailable', async () => {
  const { deps, deferred } = buildDeps();
  const schedule: ProfileSchedule = { ...SCHEDULE, times: ['09:00'], graceMinutes: 30 };
  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [schedule], []),
    OPEN_GATE,
  );
  assert.equal(deferred.rows.get('harish')?.[0]?.reasonCode, 'daemon-unavailable');
});

test("runDeferredSweepAndCatchup (bug 1, the QA-reported canonical case): a whole-day-asleep batch with ZERO per-slot records falls back to the LIVE gate reason, not daemon-unavailable — this is the spec's own worked example", async () => {
  // Reproduces the exact real-world shape: the host was asleep across
  // every one of today's slots, so NO tick ever ran to observe any of them
  // individually (zero `slotGateDeclines` entries) — the FIRST tick after
  // waking is the one processing all 5 as already-expired candidates, and
  // its own live `gate` (declined, host-asleep) is the only evidence that
  // ever existed for why they were never served. Before the fix, this
  // produced 5x `daemon-unavailable` ("the scheduler was not running") —
  // the wrong diagnosis; the host was asleep, not the daemon down.
  const { deps, deferred } = buildDeps();
  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [SCHEDULE], []),
    CLOSED_GATE, // host-asleep — the only tick that ever ran.
  );
  const rows = deferred.rows.get('harish') ?? [];
  assert.equal(rows.length, 5);
  assert.ok(
    rows.every((r) => r.reasonCode === 'host-asleep'),
    `expected every row to read host-asleep, got: ${rows.map((r) => r.reasonCode).join(', ')}`,
  );
});

test("runDeferredSweepAndCatchup (bug 1): distinct per-slot reasons are never conflated — each candidate keeps its OWN slot's attribution", async () => {
  const { deps, pidfile, deferred } = buildDeps();
  updateDaemonPidfile(
    ROOT,
    (current) => ({
      ...current,
      slotGateDeclines: [
        {
          profile: 'harish',
          date: '2026-07-27',
          slot: '09:00',
          reasonCode: 'network-unreachable',
          reason: 'net down',
          at: new Date(2026, 6, 27, 9, 15).toISOString(),
        },
        {
          profile: 'harish',
          date: '2026-07-27',
          slot: '11:30',
          reasonCode: 'host-asleep',
          reason: 'asleep',
          at: new Date(2026, 6, 27, 11, 40).toISOString(),
        },
      ],
    }),
    pidfile,
  );
  // 14:00, 16:30, 19:00 have no per-slot record at all — with the gate OPEN
  // this tick (nothing live to fall back to either), they land on
  // daemon-unavailable, distinctly from the first two.
  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [SCHEDULE], []),
    OPEN_GATE,
  );
  const rows = deferred.rows.get('harish') ?? [];
  const byslot = Object.fromEntries(rows.map((r) => [r.slot, r.reasonCode]));
  assert.deepEqual(byslot, {
    '09:00': 'network-unreachable',
    '11:30': 'host-asleep',
    '14:00': 'daemon-unavailable',
    '16:30': 'daemon-unavailable',
    '19:00': 'daemon-unavailable',
  });
});

test('runDeferredSweepAndCatchup: hasCatchupRun stops a second spawn after a daemon restart clears the pidfile attempts ledger (R8)', async () => {
  const spawnCalls: number[] = [];
  let alreadyRan = false;
  const { deps, pidfile } = buildDeps({
    spawnCatchup: async () => {
      spawnCalls.push(1);
      return 0;
    },
    hasCatchupRun: (profile, date) =>
      alreadyRan && profile === 'harish' && date === '2026-07-27',
  });

  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [SCHEDULE], []),
    OPEN_GATE,
  );
  assert.equal(spawnCalls.length, 1);

  // Simulate `serve stop && serve start`: `acquireDaemonPidfile` rewrites
  // `attempts: []` on every fresh pidfile — `alreadyLedgeredToday` alone
  // can no longer see today's earlier catch-up.
  updateDaemonPidfile(ROOT, (current) => ({ ...current, attempts: [] }), pidfile);
  // The durable `runs` table (unlike the pidfile) survived the restart —
  // it now reports today's catch-up already happened.
  alreadyRan = true;

  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [SCHEDULE], []),
    OPEN_GATE,
  );

  assert.equal(spawnCalls.length, 1); // exactly once across BOTH calls.
});

test('runDeferredSweepAndCatchup (bug 6): a persistent deferred_slots write failure is throttled to at most one warn/attempt per hour, AND still produces a message — the day is no longer silently lost', async () => {
  const notifyCalls: string[] = [];
  const { deps, events } = buildDeps({
    notify: async (profile) => {
      notifyCalls.push(profile);
      return true;
    },
  });
  // Simulates a persistent SQL write failure inside
  // `SqliteDeferredSlotStore.recordIfAbsent` (it swallows the error and
  // returns) — `listForDate` never sees the rows `recordDeferral` above
  // was asked to write, even though `candidates.length > 0`.
  deps.listForDate = () => [];

  let now = NOW;
  for (let i = 0; i < 20; i++) {
    await runDeferredSweepAndCatchup(
      deps,
      now,
      '2026-07-27',
      candidatesFor(now, [SCHEDULE], []),
      OPEN_GATE,
    );
    now = new Date(now.getTime() + 30_000); // 20 ticks, 30s apart — 10 minutes total.
  }

  // Old behavior: 0 messages ever, and a 'deferred-rows-missing' warn on
  // EVERY one of the 20 ticks. New behavior: still throttled to one
  // attempt (all 20 ticks stay within the 1-hour window), but that ONE
  // attempt actually sends — the day is no longer silently lost.
  assert.equal(notifyCalls.length, 1);
  assert.equal(events.filter((e) => e.event === 'deferred-rows-missing').length, 1);

  // Past the 1-hour throttle window: a second attempt is made.
  now = new Date(NOW.getTime() + 61 * 60_000);
  await runDeferredSweepAndCatchup(
    deps,
    now,
    '2026-07-27',
    candidatesFor(now, [SCHEDULE], []),
    OPEN_GATE,
  );
  assert.equal(notifyCalls.length, 2);
  assert.equal(events.filter((e) => e.event === 'deferred-rows-missing').length, 2);
});

test('runDeferredSweepAndCatchup (bug 2): a failing same-day T4 send is throttled to at most once per hour, not every tick', async () => {
  const notifyCalls: number[] = [];
  const { deps, deferred } = buildDeps({
    notify: async () => {
      notifyCalls.push(1);
      return false; // delivery failed, every time.
    },
  });

  let now = NOW;
  // 5 ticks, 30s apart — well within the 1-hour throttle window.
  for (let i = 0; i < 5; i++) {
    await runDeferredSweepAndCatchup(
      deps,
      now,
      '2026-07-27',
      candidatesFor(now, [SCHEDULE], []),
      OPEN_GATE,
    );
    now = new Date(now.getTime() + 30_000);
  }
  assert.equal(notifyCalls.length, 1);
  assert.ok(
    (deferred.rows.get('harish') ?? []).every((r) => r.notifiedAt === null),
    'a failed send must never stamp notifiedAt',
  );

  // Past the throttle window — the next call retries (never hard-latched).
  now = new Date(NOW.getTime() + 61 * 60_000);
  await runDeferredSweepAndCatchup(
    deps,
    now,
    '2026-07-27',
    candidatesFor(now, [SCHEDULE], []),
    OPEN_GATE,
  );
  assert.equal(notifyCalls.length, 2);
});

test('runDeferredSweepAndCatchup (bug 2 escalation): a SUCCEEDING notify with a fail-soft markNotified that never actually persists must still be throttled, not resent every tick', async () => {
  const notifyCalls: number[] = [];
  const { deps } = buildDeps({
    notify: async () => {
      notifyCalls.push(1);
      return true; // "delivered" every time...
    },
  });
  // ...but the write that should record it never sticks (fail-soft DB
  // error, silently swallowed) — `notifiedAt` stays null forever, so
  // `t4AlreadySentToday` never becomes true on its own.
  deps.markNotified = () => {};

  let now = NOW;
  for (let i = 0; i < 5; i++) {
    await runDeferredSweepAndCatchup(
      deps,
      now,
      '2026-07-27',
      candidatesFor(now, [SCHEDULE], []),
      OPEN_GATE,
    );
    now = new Date(now.getTime() + 30_000);
  }
  assert.equal(
    notifyCalls.length,
    1,
    'a succeeding send must not repeat every tick just because the write silently failed to stick',
  );
});

test('runDeferredSweepAndCatchup (bug 5): the first same-day T4 says the catch-up is starting now', async () => {
  const notifyCalls: string[] = [];
  const { deps } = buildDeps({
    notify: async (_profile, event) => {
      notifyCalls.push(event.text);
      return true;
    },
  });
  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [SCHEDULE], []),
    OPEN_GATE,
  );
  assert.match(notifyCalls[0] ?? '', /Catch-up run starting now/);
});

test("runDeferredSweepAndCatchup (bug 5): once the day's catch-up has already fired, a LATER retry of a previously-failed T4 no longer claims a fresh one is starting", async () => {
  const notifyCalls: string[] = [];
  let notifyShouldSucceed = false;
  const { deps } = buildDeps({
    notify: async (_profile, event) => {
      notifyCalls.push(event.text);
      return notifyShouldSucceed;
    },
  });
  // Tick 1: notify FAILS, but the gate is open so the catch-up itself
  // still ledgers and spawns — message and spawn are decoupled.
  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [SCHEDULE], []),
    OPEN_GATE,
  );
  assert.equal(notifyCalls.length, 1);
  assert.match(notifyCalls[0] ?? '', /Catch-up run starting now/);

  // An hour later (past the throttle window) — the catch-up has ALREADY
  // fired (ledgered on tick 1); the retry must not claim a fresh one is
  // starting.
  notifyShouldSucceed = true;
  const later = new Date(NOW.getTime() + 61 * 60_000);
  await runDeferredSweepAndCatchup(
    deps,
    later,
    '2026-07-27',
    candidatesFor(later, [SCHEDULE], []),
    OPEN_GATE,
  );
  assert.equal(notifyCalls.length, 2);
  assert.doesNotMatch(notifyCalls[1] ?? '', /Catch-up run starting now/);
  assert.match(notifyCalls[1] ?? '', /Next scheduled slot:/);
});

test('runDeferredSweepAndCatchup (bug 7): catchupGateFresh=false suppresses the catch-up gate-declined log (a reused, cached decision, not a fresh probe)', async () => {
  const { deps, events } = buildDeps();
  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [SCHEDULE], []),
    CLOSED_GATE,
    false,
  );
  assert.ok(
    !events.some((e) => e.event === 'gate-declined' && e.data?.slot === 'catchup'),
  );
});

test('runDeferredSweepAndCatchup (bug 7): catchupGateFresh defaults to true — the log still fires when the parameter is omitted (regression)', async () => {
  const { deps, events } = buildDeps();
  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [SCHEDULE], []),
    CLOSED_GATE,
  );
  assert.ok(
    events.some((e) => e.event === 'gate-declined' && e.data?.slot === 'catchup'),
  );
});

test('runRetrospectiveDeferredSweep (bug 2): a failing retrospective send is throttled to at most once per hour, not every tick', async () => {
  const notifyCalls: number[] = [];
  const { deps } = buildDeps({
    notify: async () => {
      notifyCalls.push(1);
      return false;
    },
  });
  for (let i = 0; i < 5; i++) {
    deps.recordDeferral('harish', {
      runDate: '2026-07-26',
      slot: `0${9 + i}:00`,
      reasonCode: 'host-asleep',
      reason: 'asleep',
      decidedAt: '2026-07-26T20:00:00.000Z',
    });
  }
  const schedule: ProfileSchedule = { ...SCHEDULE, weekdays: [] };

  let now = NOW;
  for (let i = 0; i < 5; i++) {
    await runRetrospectiveDeferredSweep(deps, now, '2026-07-27', [schedule]);
    now = new Date(now.getTime() + 30_000);
  }
  assert.equal(notifyCalls.length, 1);

  now = new Date(NOW.getTime() + 61 * 60_000);
  await runRetrospectiveDeferredSweep(deps, now, '2026-07-27', [schedule]);
  assert.equal(notifyCalls.length, 2);
});

test('runRetrospectiveDeferredSweep (bug 2): a successful send marks the date notified so no further attempts happen at all', async () => {
  const notifyCalls: number[] = [];
  const { deps } = buildDeps({
    notify: async () => {
      notifyCalls.push(1);
      return true;
    },
  });
  deps.recordDeferral('harish', {
    runDate: '2026-07-26',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'asleep',
    decidedAt: '2026-07-26T20:00:00.000Z',
  });
  const schedule: ProfileSchedule = { ...SCHEDULE, weekdays: [] };

  let now = NOW;
  for (let i = 0; i < 5; i++) {
    await runRetrospectiveDeferredSweep(deps, now, '2026-07-27', [schedule]);
    now = new Date(now.getTime() + 30_000);
  }
  assert.equal(notifyCalls.length, 1);
});
