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
import { runDeferredSweepAndCatchup } from './deferred_sweep.ts';
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

test('runDeferredSweepAndCatchup: a candidate whose grace window was gated names the pidfile lastGateDecline reason', async () => {
  const { deps, pidfile, deferred } = buildDeps();
  // 09:00 slot, 30-minute grace (09:00-09:30). A gate decline stamped at
  // 09:15 (inside that window) should be attributed to the recorded row.
  updateDaemonPidfile(
    ROOT,
    (current) => ({
      ...current,
      lastGateDecline: {
        reasonCode: 'network-unreachable',
        reason:
          'Job Bunny declined to start this run because the network was unreachable.',
        at: new Date(2026, 6, 27, 9, 15).toISOString(),
      },
    }),
    pidfile,
  );
  const schedule: ProfileSchedule = { ...SCHEDULE, times: ['09:00'], graceMinutes: 30 };
  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [schedule], []),
    OPEN_GATE,
  );
  assert.equal(deferred.rows.get('harish')?.[0]?.reasonCode, 'network-unreachable');
});

test('runDeferredSweepAndCatchup: no lastGateDecline within the slot window falls back to daemon-unavailable', async () => {
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

test('runDeferredSweepAndCatchup: listForDate returning [] (recordDeferral fail-soft) never triggers a notify storm', async () => {
  const notifyCalls: string[] = [];
  const { deps } = buildDeps({
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

  for (let i = 0; i < 20; i++) {
    await runDeferredSweepAndCatchup(
      deps,
      NOW,
      '2026-07-27',
      candidatesFor(NOW, [SCHEDULE], []),
      OPEN_GATE,
    );
  }

  assert.equal(notifyCalls.length, 0);
});

test('runDeferredSweepAndCatchup: a failed same-day T4 send is never stamped notified — the next call retries', async () => {
  const notifyCalls: number[] = [];
  const { deps, deferred } = buildDeps({
    notify: async () => {
      notifyCalls.push(1);
      return false; // delivery failed.
    },
  });

  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [SCHEDULE], []),
    OPEN_GATE,
  );
  assert.equal(notifyCalls.length, 1);
  assert.ok(
    (deferred.rows.get('harish') ?? []).every((r) => r.notifiedAt === null),
    'a failed send must never stamp notifiedAt',
  );

  await runDeferredSweepAndCatchup(
    deps,
    NOW,
    '2026-07-27',
    candidatesFor(NOW, [SCHEDULE], []),
    OPEN_GATE,
  );
  assert.equal(
    notifyCalls.length,
    2,
    'the next call retries since notifiedAt stayed null',
  );
});
