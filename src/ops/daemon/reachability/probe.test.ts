import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReachabilityProbeDeps } from './probe.ts';
import { probeReachable } from './probe.ts';

test('a resolving lookup returns true', async () => {
  const deps: ReachabilityProbeDeps = {
    lookup: async () => ({ address: '1.2.3.4', family: 4 }),
    timeoutMs: 2500,
  };

  assert.equal(await probeReachable(deps), true);
});

test('a lookup that never resolves times out and returns false, within a bounded wait', async () => {
  const deps: ReachabilityProbeDeps = {
    lookup: () => new Promise(() => {}), // never settles
    timeoutMs: 20,
  };

  const start = Date.now();
  const result = await probeReachable(deps);
  const elapsedMs = Date.now() - start;

  assert.equal(result, false);
  // Bounded: should resolve close to timeoutMs, not hang indefinitely.
  assert.ok(elapsedMs < 2000, `expected a bounded wait, got ${elapsedMs}ms`);
});

test('a rejecting lookup (real DNS failure) returns false without propagating', async () => {
  const deps: ReachabilityProbeDeps = {
    lookup: async () => {
      throw new Error('ENOTFOUND www.linkedin.com');
    },
    timeoutMs: 2500,
  };

  let threw = false;
  let result: boolean | undefined;
  try {
    result = await probeReachable(deps);
  } catch {
    threw = true;
  }

  assert.equal(threw, false, 'probeReachable must never throw or reject outward');
  assert.equal(result, false);
});

test('probeReachable never throws synchronously for any input', async () => {
  const deps: ReachabilityProbeDeps = {
    lookup: () => {
      throw new Error('synchronous DNS client failure');
    },
    timeoutMs: 2500,
  };

  let caught = false;
  try {
    const result = await probeReachable(deps);
    assert.equal(result, false);
  } catch {
    caught = true;
  }

  assert.equal(caught, false, 'catch block must never be reached');
});
