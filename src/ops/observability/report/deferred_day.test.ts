import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeDeferredDaySummary } from './deferred_day.ts';

// Both expected strings below are copied character-for-character from
// docs/product/pipeline-stability-hardening/mockup.html's
// data-qa="tg-deferred-day" / data-qa="tg-deferred-day-no-catchup"
// <pre> blocks — no `parse_mode` on the Telegram side (ux-notes.md §0),
// so wording IS the entire design; this pins it, not a paraphrase.
const FIVE_HOST_ASLEEP_SLOTS = [
  { slot: '09:00', reasonCode: 'host-asleep' as const },
  { slot: '11:30', reasonCode: 'host-asleep' as const },
  { slot: '14:00', reasonCode: 'host-asleep' as const },
  { slot: '16:30', reasonCode: 'host-asleep' as const },
  { slot: '19:00', reasonCode: 'host-asleep' as const },
];

test('composeDeferredDaySummary: tg-deferred-day (catch-up firing) matches the mockup byte-for-byte', () => {
  const text = composeDeferredDaySummary({
    profile: 'harish',
    date: '2026-08-12',
    slots: FIVE_HOST_ASLEEP_SLOTS,
    catchupFired: true,
    nextRunAt: null,
  });
  assert.equal(
    text,
    '⏸️ Job Bunny — harish (2026-08-12)\n' +
      '────────────────\n' +
      "Today's runs were deferred. Nothing failed.\n" +
      '\n' +
      'Job Bunny declined to start 5 runs because the host\n' +
      'was asleep and could not reach the network.\n' +
      '\n' +
      '  • 09:00 — deferred (host asleep)\n' +
      '  • 11:30 — deferred (host asleep)\n' +
      '  • 14:00 — deferred (host asleep)\n' +
      '  • 16:30 — deferred (host asleep)\n' +
      '  • 19:00 — deferred (host asleep)\n' +
      '\n' +
      'No job data was scraped today.\n' +
      'Catch-up run starting now — digest to follow.',
  );
});

test('composeDeferredDaySummary: tg-deferred-day-no-catchup matches the mockup byte-for-byte', () => {
  const text = composeDeferredDaySummary({
    profile: 'harish',
    date: '2026-08-12',
    slots: FIVE_HOST_ASLEEP_SLOTS,
    catchupFired: false,
    nextRunAt: '2026-08-13T09:00:00.000',
  });
  assert.equal(
    text,
    '⏸️ Job Bunny — harish (2026-08-12)\n' +
      '────────────────\n' +
      "Today's runs were deferred. Nothing failed.\n" +
      '\n' +
      'Job Bunny declined to start 5 runs because the host\n' +
      'was asleep and could not reach the network.\n' +
      '\n' +
      '  • 09:00 — deferred (host asleep)\n' +
      '  • 11:30 — deferred (host asleep)\n' +
      '  • 14:00 — deferred (host asleep)\n' +
      '  • 16:30 — deferred (host asleep)\n' +
      '  • 19:00 — deferred (host asleep)\n' +
      '\n' +
      'No job data was scraped today.\n' +
      'Next scheduled slot: tomorrow 09:00.',
  );
});

test('composeDeferredDaySummary: slots are sorted ascending by time regardless of input order', () => {
  const text = composeDeferredDaySummary({
    profile: 'harish',
    date: '2026-08-12',
    slots: [...FIVE_HOST_ASLEEP_SLOTS].reverse(),
    catchupFired: true,
    nextRunAt: null,
  });
  const bulletLines = text
    .split('\n')
    .filter((line) => line.startsWith('  • '))
    .map((line) => line.slice(4, 9));
  assert.deepEqual(bulletLines, ['09:00', '11:30', '14:00', '16:30', '19:00']);
});

test('composeDeferredDaySummary: a single deferred slot uses singular "run"', () => {
  const text = composeDeferredDaySummary({
    profile: 'harish',
    date: '2026-08-12',
    slots: [{ slot: '09:00', reasonCode: 'network-unreachable' }],
    catchupFired: true,
    nextRunAt: null,
  });
  assert.ok(text.includes('Job Bunny declined to start 1 run because the'));
  assert.ok(text.includes('  • 09:00 — deferred (network unreachable)'));
});

test('composeDeferredDaySummary: mixed reasonCodes fall back to a generic header clause, never crashes', () => {
  const text = composeDeferredDaySummary({
    profile: 'harish',
    date: '2026-08-12',
    slots: [
      { slot: '09:00', reasonCode: 'host-asleep' },
      { slot: '11:30', reasonCode: 'network-unreachable' },
    ],
    catchupFired: true,
    nextRunAt: null,
  });
  assert.ok(text.includes('across'));
  assert.ok(text.includes('multiple reasons'));
});

test('composeDeferredDaySummary: no-catchup variant degrades to "not currently scheduled." for a null nextRunAt', () => {
  const text = composeDeferredDaySummary({
    profile: 'harish',
    date: '2026-08-12',
    slots: FIVE_HOST_ASLEEP_SLOTS,
    catchupFired: false,
    nextRunAt: null,
  });
  assert.ok(text.endsWith('Next scheduled slot: not currently scheduled.'));
});
