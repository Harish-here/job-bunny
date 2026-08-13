import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireDaemonPidfile, readDaemonPidfile } from '../pidfile.ts';
import { fakePidfileDeps } from '../testkit/index.ts';
import { applyGateDecline, computeReachabilityGate } from './reachability_gate.ts';

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
