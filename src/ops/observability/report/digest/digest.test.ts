/**
 * digest.test.ts — TDD for formatDigest: pure function of a `RunResult`,
 * no I/O. Ported from the old `adapters/notify/telegram/format.test.ts`
 * (moved alongside `digest.ts` per the P8 layering fix) — fixtures now
 * construct real `RunResult` values directly instead of the deleted
 * `DigestInput` shadow type.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunResult } from '../../run/index.ts';
import { formatDigest } from './digest.ts';

function passedResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    profile: 'rajni',
    date: '2026-07-23',
    time: '09-00',
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

test('formatDigest: the banner includes the run date and time', () => {
  const text = formatDigest(passedResult());
  assert.match(text, /2026-07-23 09-00/);
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

test('formatDigest: dryRun option adds a loud DRY RUN line, absent by default', () => {
  const plain = formatDigest(passedResult());
  assert.doesNotMatch(plain, /DRY RUN/);

  const dry = formatDigest(passedResult(), { dryRun: true });
  assert.match(dry, /DRY RUN/);
});

// T5 (mockup ux-notes.md §4, mockup.html `tg-catchup-digest`): the
// catch-up label sits immediately after the separator, before the
// dry-run/failed-stage lines, as two lines.
test('formatDigest: catchupSlots inserts the exact T5 two-line block right after the separator', () => {
  const text = formatDigest(
    passedResult({ profile: 'harish', date: '2026-08-12', time: '20:40' }),
    { catchupSlots: ['09:00', '11:30', '14:00', '16:30', '19:00'] },
  );
  const expected = [
    '✅ Job Bunny — harish (2026-08-12 20:40)',
    '────────────────',
    'CATCH-UP RUN — stood in for 5 missed slots.',
    '(09:00, 11:30, 14:00, 16:30, 19:00)',
  ].join('\n');
  assert.equal(text.startsWith(expected), true);
});

test('formatDigest: catchupSlots singular slot uses "slot" not "slots"', () => {
  const text = formatDigest(passedResult(), { catchupSlots: ['09:00'] });
  assert.match(text, /CATCH-UP RUN — stood in for 1 missed slot\.\n\(09:00\)/);
});

test('formatDigest: omitted catchupSlots is byte-identical to the pre-T5 output (regression)', () => {
  const withoutOpt = formatDigest(passedResult());
  const withEmptyOpts = formatDigest(passedResult(), {});
  const withUndefinedCatchup = formatDigest(passedResult(), { catchupSlots: undefined });
  const withEmptyArray = formatDigest(passedResult(), { catchupSlots: [] });
  assert.equal(withoutOpt, withEmptyOpts);
  assert.equal(withoutOpt, withUndefinedCatchup);
  assert.equal(withoutOpt, withEmptyArray);
  assert.doesNotMatch(withoutOpt, /CATCH-UP RUN/);
});

// R11 (Should) — ux-notes.md §5 / mockup.html:638-641 literal block, placed after
// the funnel block on a passed run with soft-failed search links.
test('formatDigest: a passed run with linkSoftErrors renders the exact UX §5 block after the funnel', () => {
  const text = formatDigest(
    passedResult({
      linkSoftErrors: [
        {
          url: 'https://www.linkedin.com/jobs/search-results/?keywords=sre',
          label: 'Comcast SRE',
          reason: 'results list never loaded',
        },
        {
          url: 'https://www.linkedin.com/jobs/search-results/?keywords=zafin',
          label: 'Zafin',
          reason: 'results list never loaded',
        },
      ],
    }),
  );
  const expectedBlock = [
    '⚠️ 2 search links failed — LinkedIn is fine (an earlier link still loads):',
    '  • Comcast SRE — results list never loaded',
    '  • Zafin — results list never loaded',
    'Fix: board → Settings → Where jobs come from',
  ].join('\n');
  assert.equal(text.endsWith(expectedBlock), true);
  // directly after the last funnel line, no blank line in between
  const funnelLastLine =
    '  • filter: 40 → 12 (dropped — avoidCompany: 5, staleLocation: 3)';
  assert.match(
    text,
    new RegExp(
      `${funnelLastLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n⚠️ 2 search links failed`,
    ),
  );
});

test('formatDigest: absent when linkSoftErrors is missing or empty (no block, no trailing noise)', () => {
  const withoutField = formatDigest(passedResult());
  const withEmptyArray = formatDigest(passedResult({ linkSoftErrors: [] }));
  assert.doesNotMatch(withoutField, /search link.*failed/);
  assert.doesNotMatch(withoutField, /Fix: board/);
  assert.doesNotMatch(withEmptyArray, /search link.*failed/);
});

test('formatDigest: singular count reads "1 search link failed"', () => {
  const text = formatDigest(
    passedResult({
      linkSoftErrors: [
        { url: 'https://linkedin.com/jobs/x', label: 'X', reason: 'timed out' },
      ],
    }),
  );
  assert.match(text, /⚠️ 1 search link failed — LinkedIn is fine/);
});

test('formatDigest: labelless entries fall back to a shortened URL', () => {
  const text = formatDigest(
    passedResult({
      linkSoftErrors: [
        {
          url: 'https://www.linkedin.com/jobs/search-results/Remote',
          reason: 'results list never loaded',
        },
      ],
    }),
  );
  assert.match(text, /• linkedin\.com\/.*Remote — results list never loaded/);
});

test('formatDigest: lists up to 5 entries then "+N more" for a 7-entry list', () => {
  const linkSoftErrors = Array.from({ length: 7 }, (_, i) => ({
    url: `https://linkedin.com/jobs/x${i}`,
    label: `Link ${i}`,
    reason: 'results list never loaded',
  }));
  const text = formatDigest(passedResult({ linkSoftErrors }));
  const bulletCount = (text.match(/^ {2}• Link \d+ —/gm) ?? []).length;
  assert.equal(bulletCount, 5);
  assert.match(text, /\+2 more/);
  assert.doesNotMatch(text, /Link 5/);
  assert.doesNotMatch(text, /Link 6/);
});

test('formatDigest: linkSoftErrors on a failed outcome is byte-identical to today (block never renders)', () => {
  const withoutField = formatDigest(
    passedResult({ outcome: 'failed', failedStage: 'filter' }),
  );
  const withField = formatDigest(
    passedResult({
      outcome: 'failed',
      failedStage: 'filter',
      linkSoftErrors: [
        { url: 'https://linkedin.com/jobs/x', label: 'X', reason: 'timed out' },
      ],
    }),
  );
  assert.equal(withField, withoutField);
});
