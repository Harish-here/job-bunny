import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SUSPECTED_SUSPEND_GAP_MS,
  TICK_MS,
  trackWakeSettle,
  WAKE_SETTLE_MS,
  wasHostSuspended,
} from './suspend.ts';

test('wasHostSuspended returns true for a 121s gap', () => {
  assert.equal(wasHostSuspended(121_000), true);
});

test('wasHostSuspended returns false for a 30s gap', () => {
  assert.equal(wasHostSuspended(30_000), false);
});

test('wasHostSuspended returns false exactly at the boundary (120_000ms)', () => {
  assert.equal(wasHostSuspended(SUSPECTED_SUSPEND_GAP_MS), false);
  assert.equal(wasHostSuspended(120_000), false);
});

test('wasHostSuspended returns true just past the boundary (120_001ms)', () => {
  assert.equal(wasHostSuspended(SUSPECTED_SUSPEND_GAP_MS + 1), true);
  assert.equal(wasHostSuspended(120_001), true);
});

test('trackWakeSettle: a suspend-sized gap declines and starts the window at now', () => {
  assert.deepEqual(trackWakeSettle(15 * 60_000, 1_000_000, undefined), {
    declined: true,
    resumedAtMs: 1_000_000,
  });
});

test('trackWakeSettle: small gaps keep declining until WAKE_SETTLE_MS has passed, then settle', () => {
  const t0 = 1_000_000;
  let state = trackWakeSettle(15 * 60_000, t0, undefined);
  for (let i = 1; i < 6; i++) {
    state = trackWakeSettle(TICK_MS, t0 + i * TICK_MS, state.resumedAtMs);
    assert.equal(state.declined, true, `tick +${i * 30}s must still decline`);
  }
  state = trackWakeSettle(TICK_MS, t0 + WAKE_SETTLE_MS, state.resumedAtMs);
  assert.deepEqual(state, { declined: false, resumedAtMs: undefined });
});

test('trackWakeSettle: exactly WAKE_SETTLE_MS settles, one ms earlier does not', () => {
  assert.equal(
    trackWakeSettle(TICK_MS, 1_000 + WAKE_SETTLE_MS - 1, 1_000).declined,
    true,
  );
  assert.equal(trackWakeSettle(TICK_MS, 1_000 + WAKE_SETTLE_MS, 1_000).declined, false);
});

test('trackWakeSettle: a new suspend-sized gap mid-settle resets the window', () => {
  const state = trackWakeSettle(10 * 60_000, 1_000_000 + 90_000, 1_000_000);
  assert.deepEqual(state, { declined: true, resumedAtMs: 1_090_000 });
});

test('trackWakeSettle: no prior window and a normal gap does not decline; NaN gap fails open', () => {
  assert.deepEqual(trackWakeSettle(TICK_MS, 5_000, undefined), {
    declined: false,
    resumedAtMs: undefined,
  });
  assert.deepEqual(trackWakeSettle(Number.NaN, 5_000, undefined), {
    declined: false,
    resumedAtMs: undefined,
  });
});

test('WAKE_SETTLE_MS is 180s (6 ticks), longer than the longest observed DarkWake (63s)', () => {
  assert.equal(WAKE_SETTLE_MS, 180_000);
});
