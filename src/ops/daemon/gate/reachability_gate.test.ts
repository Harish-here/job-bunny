import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireDaemonPidfile, readDaemonPidfile } from '../pidfile.ts';
import { fakePidfileDeps } from '../testkit/index.ts';
import {
  applyGateDecline,
  CATCHUP_GATE_RETRY_INTERVAL_MS,
  type CatchupGateCache,
  computeCatchupOnlyGate,
  computeReachabilityGate,
} from './reachability_gate.ts';

const NOW = new Date(2026, 6, 27, 14, 4);

test('computeReachabilityGate: a large gap since the last tick declines with host-asleep, never probing', async () => {
  let probed = 0;
  const gate = await computeReachabilityGate(
    new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    NOW,
    true,
    async () => {
      probed += 1;
      return true;
    },
  );
  assert.deepEqual(gate, {
    declined: true,
    reasonCode: 'host-asleep',
    reason: 'Job Bunny declined to start this run because the host was asleep.',
  });
  assert.equal(probed, 0); // suspected short-circuits the probe entirely.
});

test('computeReachabilityGate: a small gap and an empty batch never probes and is not declined', async () => {
  let probed = 0;
  const gate = await computeReachabilityGate(
    new Date(NOW.getTime() - 10_000).toISOString(),
    NOW,
    false, // no owed entries this tick.
    async () => {
      probed += 1;
      return false; // would decline if it were ever consulted.
    },
  );
  assert.equal(gate.declined, false);
  assert.equal(probed, 0);
});

test('computeReachabilityGate: a small gap, an owed entry, and an unreachable probe declines with network-unreachable', async () => {
  const gate = await computeReachabilityGate(
    new Date(NOW.getTime() - 10_000).toISOString(),
    NOW,
    true,
    async () => false,
  );
  assert.deepEqual(gate, {
    declined: true,
    reasonCode: 'network-unreachable',
    reason: 'Job Bunny declined to start this run because the network was unreachable.',
  });
});

test('computeReachabilityGate: a reachable probe is not declined (regression)', async () => {
  const gate = await computeReachabilityGate(
    new Date(NOW.getTime() - 10_000).toISOString(),
    NOW,
    true,
    async () => true,
  );
  assert.deepEqual(gate, { declined: false, reasonCode: null, reason: null });
});

test('computeReachabilityGate: an undefined previousLastTickAt (first tick ever) fails open to "not suspected"', async () => {
  const gate = await computeReachabilityGate(undefined, NOW, true, async () => true);
  assert.equal(gate.declined, false);
});

test('applyGateDecline: logs gate-declined and stamps lastGateDecline for a reasoned decline', () => {
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile('/fake/root', 1, pidfile);
  const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
  applyGateDecline(
    '/fake/root',
    pidfile,
    (event, data) => events.push({ event, data }),
    'harish',
    '2026-07-27',
    '14:00',
    {
      declined: true,
      reasonCode: 'host-asleep',
      reason: 'Job Bunny declined to start this run because the host was asleep.',
    },
    NOW,
  );
  assert.deepEqual(events, [
    {
      event: 'gate-declined',
      data: { profile: 'harish', slot: '14:00', reasonCode: 'host-asleep' },
    },
  ]);
  const pf = readDaemonPidfile('/fake/root', pidfile);
  assert.deepEqual(pf?.lastGateDecline, {
    reasonCode: 'host-asleep',
    reason: 'Job Bunny declined to start this run because the host was asleep.',
    at: NOW.toISOString(),
  });
});

test('applyGateDecline: upserts a per-slot entry into slotGateDeclines (bug 1) — a second decline for the SAME slot replaces, not duplicates', () => {
  const pidfile = fakePidfileDeps();
  acquireDaemonPidfile('/fake/root', 1, pidfile);
  const noop = () => {};
  applyGateDecline(
    '/fake/root',
    pidfile,
    noop,
    'harish',
    '2026-07-27',
    '09:00',
    {
      declined: true,
      reasonCode: 'network-unreachable',
      reason: 'Job Bunny declined to start this run because the network was unreachable.',
    },
    new Date(2026, 6, 27, 9, 5),
  );
  // A DIFFERENT slot's own decline, a different reason — must not clobber
  // or merge with 09:00's own entry.
  applyGateDecline(
    '/fake/root',
    pidfile,
    noop,
    'harish',
    '2026-07-27',
    '11:30',
    {
      declined: true,
      reasonCode: 'host-asleep',
      reason: 'Job Bunny declined to start this run because the host was asleep.',
    },
    new Date(2026, 6, 27, 11, 40),
  );
  // A later tick's decline for the SAME 09:00 slot — replaces its own
  // entry, does not accumulate a second row for it.
  applyGateDecline(
    '/fake/root',
    pidfile,
    noop,
    'harish',
    '2026-07-27',
    '09:00',
    {
      declined: true,
      reasonCode: 'host-asleep',
      reason: 'Job Bunny declined to start this run because the host was asleep.',
    },
    new Date(2026, 6, 27, 9, 25),
  );

  const pf = readDaemonPidfile('/fake/root', pidfile);
  assert.equal(pf?.slotGateDeclines.length, 2);
  const slot0900 = pf?.slotGateDeclines.find((d) => d.slot === '09:00');
  const slot1130 = pf?.slotGateDeclines.find((d) => d.slot === '11:30');
  assert.equal(slot0900?.reasonCode, 'host-asleep'); // replaced, not the first reason.
  assert.equal(slot1130?.reasonCode, 'host-asleep');
});

test('computeCatchupOnlyGate (bug 7): no cache -> probes fresh and populates the cache on a decline', async () => {
  let probed = 0;
  const result = await computeCatchupOnlyGate(undefined, NOW, undefined, async () => {
    probed += 1;
    return false;
  });
  assert.equal(probed, 1);
  assert.equal(result.fresh, true);
  assert.equal(result.gate.declined, true);
  assert.equal(result.gate.reasonCode, 'network-unreachable');
  assert.equal(result.cache?.reasonCode, 'network-unreachable');
  assert.equal(result.cache?.at, NOW.getTime());
});

test('computeCatchupOnlyGate (bug 8, CRITICAL): the gate DECISION is recomputed every tick, never served from cache — a cache hit still probes and still returns the live result', async () => {
  let probed = 0;
  const cache: CatchupGateCache = {
    reasonCode: 'host-asleep',
    reason: 'asleep',
    at: NOW.getTime() - 1000, // 1s ago — well within the log-throttle interval.
  };
  // The live probe now says REACHABLE — if the decision were served from
  // cache (the bug), this would still return `declined: true`.
  const result = await computeCatchupOnlyGate(cache, NOW, undefined, async () => {
    probed += 1;
    return true;
  });
  assert.equal(probed, 1, 'must probe fresh on every tick, even with a recent cache');
  assert.equal(result.gate.declined, false, 'the decision must reflect the LIVE probe');
  assert.equal(result.cache, undefined, 'a reachable result clears the log cache');
});

test('computeCatchupOnlyGate (bug 7, log only): a fresh cache within the interval suppresses the LOG (fresh: false) but the decision is still freshly computed', async () => {
  let probed = 0;
  const cache: CatchupGateCache = {
    reasonCode: 'network-unreachable',
    reason: 'down',
    at: NOW.getTime() - 1000, // 1s ago — well within the interval.
  };
  const result = await computeCatchupOnlyGate(cache, NOW, undefined, async () => {
    probed += 1;
    return false; // still unreachable — same reasonCode as the cache.
  });
  assert.equal(probed, 1, 'the probe always runs — only the LOG is throttled');
  assert.equal(result.fresh, false, 'same reason within the window -> log suppressed');
  assert.deepEqual(result.gate, {
    declined: true,
    reasonCode: 'network-unreachable',
    reason: 'Job Bunny declined to start this run because the network was unreachable.',
  });
  assert.equal(result.cache, cache); // log-window cache unchanged.
});

test('computeCatchupOnlyGate (bug 7, log only): a cache exactly at the interval boundary still suppresses the log (inclusive)', async () => {
  const cache: CatchupGateCache = {
    reasonCode: 'network-unreachable',
    reason: 'down',
    at: NOW.getTime() - CATCHUP_GATE_RETRY_INTERVAL_MS,
  };
  const result = await computeCatchupOnlyGate(cache, NOW, undefined, async () => false);
  assert.equal(result.fresh, false);
});

test('computeCatchupOnlyGate (bug 7, log only): past the interval, the log fires again and the cache is replaced', async () => {
  const staleCache: CatchupGateCache = {
    reasonCode: 'network-unreachable',
    reason: 'down',
    at: NOW.getTime() - CATCHUP_GATE_RETRY_INTERVAL_MS - 1,
  };
  const result = await computeCatchupOnlyGate(
    staleCache,
    NOW,
    undefined,
    async () => false,
  );
  assert.equal(result.fresh, true);
  assert.equal(result.cache?.at, NOW.getTime());
});

test('computeCatchupOnlyGate: a fresh probe that finds things reachable clears the cache entirely', async () => {
  const staleCache: CatchupGateCache = {
    reasonCode: 'network-unreachable',
    reason: 'down',
    at: NOW.getTime() - CATCHUP_GATE_RETRY_INTERVAL_MS - 1,
  };
  const result = await computeCatchupOnlyGate(
    staleCache,
    NOW,
    undefined,
    async () => true,
  );
  assert.equal(result.gate.declined, false);
  assert.equal(result.cache, undefined);
});

test('computeCatchupOnlyGate (bug 8): a DIFFERENT reasonCode within the window resets the log immediately, even though the decline never lets up', async () => {
  const cache: CatchupGateCache = {
    reasonCode: 'host-asleep',
    reason: 'asleep',
    at: NOW.getTime() - 1000,
  };
  const result = await computeCatchupOnlyGate(
    cache,
    NOW,
    new Date(NOW.getTime() - 10_000).toISOString(), // small gap -> not suspected.
    async () => false, // unreachable -> network-unreachable, a DIFFERENT reason.
  );
  assert.equal(result.gate.reasonCode, 'network-unreachable');
  assert.equal(
    result.fresh,
    true,
    'a changed reason must log again, not stay suppressed',
  );
});

test('computeCatchupOnlyGate: a large previousLastTickAt gap declines host-asleep, probing is skipped by computeReachabilityGate itself (suspected short-circuits before the probe)', async () => {
  let probed = 0;
  const result = await computeCatchupOnlyGate(
    undefined,
    NOW,
    new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    async () => {
      probed += 1;
      return true;
    },
  );
  assert.equal(probed, 0);
  assert.equal(result.gate.reasonCode, 'host-asleep');
  assert.equal(result.cache?.reasonCode, 'host-asleep');
});
