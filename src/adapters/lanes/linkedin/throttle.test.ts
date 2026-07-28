import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JdOutcome } from './throttle.ts';
import {
  THROTTLE_CONSECUTIVE_SHELLS_TO_TRIP,
  THROTTLE_COOLDOWN_MS,
  ThrottleCounter,
} from './throttle.ts';

test('thresholds are the spec values: 3 consecutive shells (D5), 4h cooldown (D7)', () => {
  assert.equal(THROTTLE_CONSECUTIVE_SHELLS_TO_TRIP, 3);
  assert.equal(THROTTLE_COOLDOWN_MS, 14_400_000);
});

const CASES: Array<{ name: string; outcomes: JdOutcome[]; tripped: boolean }> = [
  { name: 'no outcomes recorded at all', outcomes: [], tripped: false },
  { name: 'one shell', outcomes: ['shell'], tripped: false },
  {
    name: 'two consecutive shells (one below threshold)',
    outcomes: ['shell', 'shell'],
    tripped: false,
  },
  {
    name: 'three consecutive shells',
    outcomes: ['shell', 'shell', 'shell'],
    tripped: true,
  },
  {
    name: 'four consecutive shells stays tripped',
    outcomes: ['shell', 'shell', 'shell', 'shell'],
    tripped: true,
  },
  {
    name: 'an ok between shells resets the streak',
    outcomes: ['shell', 'shell', 'ok', 'shell', 'shell'],
    tripped: false,
  },
  {
    name: 'an ok after three shells clears the trip',
    outcomes: ['shell', 'shell', 'shell', 'ok'],
    tripped: false,
  },
  {
    name: 'missing never counts toward a trip, however many',
    outcomes: ['missing', 'missing', 'missing', 'missing', 'missing'],
    tripped: false,
  },
  {
    name: 'missing does not break a shell streak either',
    outcomes: ['shell', 'missing', 'shell', 'missing', 'shell'],
    tripped: true,
  },
  {
    name: 'ok outcomes alone never trip',
    outcomes: ['ok', 'ok', 'ok', 'ok'],
    tripped: false,
  },
];

for (const testCase of CASES) {
  test(`ThrottleCounter: ${testCase.name} -> tripped=${testCase.tripped}`, () => {
    const counter = new ThrottleCounter();
    for (const outcome of testCase.outcomes) counter.record(outcome);
    assert.equal(counter.tripped, testCase.tripped);
  });
}

test('ThrottleCounter: tripped flips exactly at the threshold, not before', () => {
  const counter = new ThrottleCounter();
  counter.record('shell');
  assert.equal(counter.tripped, false);
  counter.record('shell');
  assert.equal(counter.tripped, false);
  counter.record('shell');
  assert.equal(counter.tripped, true);
});

test('ThrottleCounter: honors an injected threshold (so a test never has to hardcode 3)', () => {
  const counter = new ThrottleCounter(2);
  counter.record('shell');
  assert.equal(counter.tripped, false);
  counter.record('shell');
  assert.equal(counter.tripped, true);
});
