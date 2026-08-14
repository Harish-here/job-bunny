import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SUSPECTED_SUSPEND_GAP_MS, wasHostSuspended } from './suspend.ts';

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
