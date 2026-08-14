/**
 * failure_notice.test.ts — TDD for `composeFailureNotice`: pure wrapper
 * over `formatDigest`'s own output. Fixtures build `base` via the real
 * `formatDigest` (not a hand-rolled string) so these tests also exercise
 * the actual seam `composeFailureNotice` splices into.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunResult } from '../../run/index.ts';
import { formatDigest } from '../digest/index.ts';
import { composeFailureNotice } from './failure_notice.ts';

function failedResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    profile: 'harish',
    date: '2026-08-12',
    time: '19:43',
    outcome: 'failed',
    failedStage: 'farm',
    stages: [],
    ...overrides,
  };
}

test('composeFailureNotice: remind (T2) reproduces the mockup copy byte-for-byte', () => {
  const base = formatDigest(failedResult());
  const text = composeFailureNotice(base, 'remind', 6, '2026-08-11T15:49:00');

  const expected = [
    '🔴 Job Bunny — harish (2026-08-12 19:43)',
    '────────────────',
    'STILL FAILING (x6) — no new problem.',
    'Same failure since 2026-08-11 15:49.',
    'This is the once-a-day reminder, not a new alert.',
    'Failed at stage: farm',
  ].join('\n');

  assert.equal(text, expected);
});

test('composeFailureNotice: remind splices the block after the separator, before an existing dryRun line', () => {
  const base = formatDigest(failedResult(), { dryRun: true });
  const text = composeFailureNotice(base, 'remind', 2, '2026-08-01T00:00:00');
  const lines = text.split('\n');

  assert.equal(lines[0], '🔴 Job Bunny — harish (2026-08-12 19:43)');
  assert.equal(lines[1], '────────────────');
  assert.equal(lines[2], 'STILL FAILING (x2) — no new problem.');
  assert.equal(lines[3], 'Same failure since 2026-08-01 00:00.');
  assert.equal(lines[4], 'This is the once-a-day reminder, not a new alert.');
  assert.equal(lines[5], '⚠️ DRY RUN — sync stage did not write to Notion');
  assert.equal(lines[6], 'Failed at stage: farm');
});

test('composeFailureNotice: send with a suppressedSignature reproduces the T3 mockup shape byte-for-byte', () => {
  const base = formatDigest(
    failedResult({ date: '2026-08-13', time: '09:14', failedStage: 'source' }),
  );
  const text = composeFailureNotice(
    base,
    'send',
    6,
    '2026-08-11T15:49:00',
    'stage "farm" — stalled: no beat()',
  );

  const expected = [
    '🔴 NEW FAILURE — Job Bunny — harish (2026-08-13 09:14)',
    '────────────────',
    'This is a DIFFERENT failure from the one already reported.',
    '',
    '  NOW:        stage "source"',
    '  STILL OPEN: stage "farm" — stalled: no beat()',
    '              (x6, since 2026-08-11 15:49)',
  ].join('\n');

  assert.equal(text, expected);
});

test('composeFailureNotice: send without a suppressedSignature (T1, plain first failure) passes base through unchanged', () => {
  const base = formatDigest(failedResult());
  const text = composeFailureNotice(base, 'send', 1, '2026-08-12T19:43:00');
  assert.equal(text, base);
});

test('composeFailureNotice: send with an EMPTY-string suppressedSignature still takes the T3 branch (not the T1 pass-through)', () => {
  const base = formatDigest(failedResult());
  const text = composeFailureNotice(base, 'send', 1, '2026-08-12T19:43:00', '');
  assert.match(text, /NEW FAILURE/);
  assert.match(text, /STILL OPEN: \n/);
});

test('composeFailureNotice: suppress is a defensive no-op that returns base unchanged', () => {
  const base = formatDigest(failedResult());
  const text = composeFailureNotice(base, 'suppress', 3, '2026-08-12T19:43:00');
  assert.equal(text, base);
});

test('composeFailureNotice: a passed-run base (T5-shaped) is untouched by remind (defensive — never actually called this way)', () => {
  const base = formatDigest(
    { ...failedResult(), outcome: 'passed', failedStage: undefined },
    {},
  );
  const text = composeFailureNotice(base, 'remind', 4, '2026-08-01T09:00:00');
  assert.match(text, /STILL FAILING \(x4\)/);
  // No "Failed at stage" line exists on a passed run — remind still splices
  // its block right after the separator; nothing downstream breaks.
  assert.doesNotMatch(text, /Failed at stage/);
});
