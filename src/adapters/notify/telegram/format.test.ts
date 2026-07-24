/**
 * format.test.ts — TDD for formatDigest: pure function of a RunResult-shaped
 * fixture, no I/O. Fixtures carry the extra `elapsedMs`/`attempts` fields a
 * real `RunResult` stage has (see `format.ts`'s header on why `DigestInput`
 * is a locally-declared structural subset rather than an import of the real
 * `RunResult`) to confirm the caller can pass a real `RunResult` straight
 * through with no cast.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type DigestInput, formatDigest } from './format.ts';

type RunResultFixture = DigestInput & {
  stages: Array<DigestInput['stages'][number] & { elapsedMs: number; attempts: number }>;
};

function passedResult(overrides: Partial<RunResultFixture> = {}): RunResultFixture {
  return {
    profile: 'rajni',
    date: '2026-07-23',
    outcome: 'passed',
    stages: [
      {
        name: 'extract',
        elapsedMs: 1000,
        attempts: 1,
        jobsIn: 0,
        jobsOut: 40,
        dropsByRule: {},
      },
      {
        name: 'filter',
        elapsedMs: 500,
        attempts: 1,
        jobsIn: 40,
        jobsOut: 12,
        dropsByRule: { avoidCompany: 5, staleLocation: 3 },
      },
    ],
    ...overrides,
  };
}

test('formatDigest: includes the Job Bunny banner with the profile name', () => {
  const text = formatDigest(passedResult());
  assert.match(text, /✅ Job Bunny — rajni/);
});

test('formatDigest: includes the separator line', () => {
  const text = formatDigest(passedResult());
  assert.match(text, /────────────────/);
});

test('formatDigest: a passed outcome shows the ✅ status icon in the banner', () => {
  const text = formatDigest(passedResult());
  assert.match(text, /✅ Job Bunny — rajni/);
});

test('formatDigest: a failed outcome shows the 🔴 status icon in the banner and the failing stage', () => {
  const text = formatDigest(passedResult({ outcome: 'failed', failedStage: 'filter' }));
  assert.match(text, /🔴 Job Bunny — rajni/);
  assert.match(text, /Failed at stage: filter/);
});

test('formatDigest: includes a per-stage funnel line with jobsIn -> jobsOut', () => {
  const text = formatDigest(passedResult());
  assert.match(text, /extract/);
  assert.match(text, /0.*40/);
  assert.match(text, /filter/);
  assert.match(text, /40.*12/);
});

test('formatDigest: includes drop-rule breakdown for a stage that dropped jobs', () => {
  const text = formatDigest(passedResult());
  assert.match(text, /avoidCompany/);
  assert.match(text, /5/);
  assert.match(text, /staleLocation/);
  assert.match(text, /3/);
});

test('formatDigest: a stage with no drops does not print an empty breakdown', () => {
  const text = formatDigest(passedResult());
  const extractLine = text.split('\n').find((line) => line.includes('extract'));
  assert.ok(extractLine);
  assert.doesNotMatch(extractLine as string, /\{\}/);
});

test('formatDigest: handles zero stages without throwing', () => {
  const text = formatDigest(passedResult({ stages: [] }));
  assert.match(text, /✅ Job Bunny — rajni/);
});
