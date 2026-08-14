import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type DedupState, DedupStateSchema, decideNotification } from './dedup.ts';

const T0 = '2026-08-11T15:49:00.000Z';
const DAY_MS = 24 * 60 * 60_000;

test('first-ever failure (prior undefined) sends with consecutiveCount 1', () => {
  const result = decideNotification(undefined, 'sig-a', T0);
  assert.equal(result.action, 'send');
  assert.deepEqual(result.nextState, {
    signature: 'sig-a',
    firstSeenAt: T0,
    lastNotifiedAt: T0,
    consecutiveCount: 1,
  });
});

test('N consecutive same-signature failures within 24h: first sends, rest suppress, count increments, lastNotifiedAt pinned', () => {
  let prior: DedupState | undefined;
  const times: string[] = [
    T0,
    '2026-08-11T16:00:00.000Z',
    '2026-08-11T20:00:00.000Z',
    '2026-08-12T02:00:00.000Z',
    '2026-08-12T10:00:00.000Z',
  ];
  const firstTime = times[0] as string;

  const first = decideNotification(prior, 'sig-a', firstTime);
  assert.equal(first.action, 'send');
  assert.deepEqual(first.nextState, {
    signature: 'sig-a',
    firstSeenAt: firstTime,
    lastNotifiedAt: firstTime,
    consecutiveCount: 1,
  });
  prior = first.nextState;

  for (let i = 1; i < times.length; i++) {
    const at = times[i] as string;
    const result = decideNotification(prior, 'sig-a', at);
    assert.equal(result.action, 'suppress', `call ${i} should suppress`);
    assert.deepEqual(result.nextState, {
      signature: 'sig-a',
      firstSeenAt: firstTime,
      lastNotifiedAt: firstTime,
      consecutiveCount: i + 1,
    });
    prior = result.nextState;
  }

  assert.equal(prior.consecutiveCount, 5);
});

test('once now crosses 24h past the original lastNotifiedAt, next call reminds and advances lastNotifiedAt', () => {
  const first = decideNotification(undefined, 'sig-a', T0);
  let prior = first.nextState;

  // A couple of suppressed calls in between.
  prior = decideNotification(prior, 'sig-a', '2026-08-11T16:00:00.000Z').nextState;
  prior = decideNotification(prior, 'sig-a', '2026-08-11T20:00:00.000Z').nextState;
  assert.equal(prior.consecutiveCount, 3);
  assert.equal(prior.lastNotifiedAt, T0);

  const past24h = new Date(Date.parse(T0) + DAY_MS + 1).toISOString();
  const remind = decideNotification(prior, 'sig-a', past24h);
  assert.equal(remind.action, 'remind');
  assert.deepEqual(remind.nextState, {
    signature: 'sig-a',
    firstSeenAt: T0,
    lastNotifiedAt: past24h,
    consecutiveCount: 4,
  });
});

test('a signature change while suppressed always sends, never suppresses, and resets consecutiveCount to 1', () => {
  const first = decideNotification(undefined, 'sig-a', T0);
  let prior = first.nextState;
  prior = decideNotification(prior, 'sig-a', '2026-08-11T16:00:00.000Z').nextState;
  prior = decideNotification(prior, 'sig-a', '2026-08-11T20:00:00.000Z').nextState;
  assert.equal(prior.consecutiveCount, 3);

  // Still well within 24h of lastNotifiedAt (T0), but signature differs.
  const changed = decideNotification(prior, 'sig-b', '2026-08-11T21:00:00.000Z');
  assert.equal(changed.action, 'send');
  assert.deepEqual(changed.nextState, {
    signature: 'sig-b',
    firstSeenAt: '2026-08-11T21:00:00.000Z',
    lastNotifiedAt: '2026-08-11T21:00:00.000Z',
    consecutiveCount: 1,
  });
});

test('24h boundary: exactly 24h since lastNotifiedAt reminds; 24h - 1ms suppresses', () => {
  const first = decideNotification(undefined, 'sig-a', T0);
  const prior = first.nextState;

  const exactly24h = new Date(Date.parse(T0) + DAY_MS).toISOString();
  const atBoundary = decideNotification(prior, 'sig-a', exactly24h);
  assert.equal(atBoundary.action, 'remind');
  assert.deepEqual(atBoundary.nextState, {
    signature: 'sig-a',
    firstSeenAt: T0,
    lastNotifiedAt: exactly24h,
    consecutiveCount: 2,
  });

  const justBefore24h = new Date(Date.parse(T0) + DAY_MS - 1).toISOString();
  const beforeBoundary = decideNotification(prior, 'sig-a', justBefore24h);
  assert.equal(beforeBoundary.action, 'suppress');
  assert.deepEqual(beforeBoundary.nextState, {
    signature: 'sig-a',
    firstSeenAt: T0,
    lastNotifiedAt: T0,
    consecutiveCount: 2,
  });
});

test('DedupStateSchema parses a well-formed DedupState and rejects a malformed one', () => {
  const state: DedupState = {
    signature: 'farm::stalled',
    firstSeenAt: T0,
    lastNotifiedAt: T0,
    consecutiveCount: 1,
  };
  assert.deepEqual(DedupStateSchema.parse(state), state);
  assert.throws(() => DedupStateSchema.parse({ signature: 'farm::stalled' }));
});
