import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatRunTime } from './time.ts';

test('formatRunTime: zero-pads HH-MM from the local clock', () => {
  assert.equal(formatRunTime(new Date(2026, 6, 21, 9, 5)), '09-05');
  assert.equal(formatRunTime(new Date(2026, 6, 21, 23, 59)), '23-59');
  assert.equal(formatRunTime(new Date(2026, 6, 21, 0, 0)), '00-00');
});
