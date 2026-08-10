import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  formatDate,
  formatInstant,
  formatInstantFull,
  formatInstantTitle,
  formatRelative,
} from './datetime.ts';

// Local (never ISO literal) frozen "now": Mon Aug 10 2026, 10:00:00 PM
// host-local. Every test date below is built the same way, so these tests
// are timezone-independent (they exercise local getters regardless of the
// host's actual offset).
const NOW = new Date(2026, 7, 10, 22, 0, 0);

// ---------------------------------------------------------------------
// formatInstant
// ---------------------------------------------------------------------

test('formatInstant: today renders "Today <time>"', () => {
  const d = new Date(2026, 7, 10, 14, 36, 0);
  assert.equal(formatInstant(d.toISOString(), NOW), 'Today 2:36 PM');
});

test('formatInstant: yesterday renders "Yesterday <time>"', () => {
  const d = new Date(2026, 7, 9, 9, 0, 0);
  assert.equal(formatInstant(d.toISOString(), NOW), 'Yesterday 9:00 AM');
});

test('formatInstant: calendar-boundary case — 11 PM yesterday viewed at 10 PM today is Yesterday, not a 24h delta', () => {
  const d = new Date(2026, 7, 9, 23, 0, 0);
  assert.equal(formatInstant(d.toISOString(), NOW), 'Yesterday 11:00 PM');
});

test('formatInstant: an older date renders the absolute form', () => {
  const d = new Date(2026, 7, 1, 9, 15, 0);
  assert.equal(formatInstant(d.toISOString(), NOW), '1 Aug 2026 9:15 AM');
});

test('formatInstant: a future date renders the absolute form (no "Tomorrow" hint for instants)', () => {
  const d = new Date(2026, 7, 12, 10, 0, 0);
  assert.equal(formatInstant(d.toISOString(), NOW), '12 Aug 2026 10:00 AM');
});

test('formatInstant: midnight renders 12:00 AM', () => {
  const d = new Date(2026, 7, 10, 0, 0, 0);
  assert.equal(formatInstant(d.toISOString(), NOW), 'Today 12:00 AM');
});

test('formatInstant: noon renders 12:00 PM', () => {
  const d = new Date(2026, 7, 10, 12, 0, 0);
  assert.equal(formatInstant(d.toISOString(), NOW), 'Today 12:00 PM');
});

test('formatInstant: single-digit day and hour carry no leading zero', () => {
  const d = new Date(2026, 7, 2, 2, 5, 0);
  assert.equal(formatInstant(d.toISOString(), NOW), '2 Aug 2026 2:05 AM');
});

test('formatInstant: invalid input returns em dash', () => {
  assert.equal(formatInstant('', NOW), '—');
  assert.equal(formatInstant('not-a-date', NOW), '—');
});

// ---------------------------------------------------------------------
// formatInstantFull
// ---------------------------------------------------------------------

test('formatInstantFull: always absolute, with seconds', () => {
  const d = new Date(2026, 7, 10, 14, 36, 12);
  assert.equal(formatInstantFull(d.toISOString()), '10 Aug 2026 2:36:12 PM');
});

test('formatInstantFull: midnight and noon', () => {
  const midnight = new Date(2026, 7, 10, 0, 0, 5);
  const noon = new Date(2026, 7, 10, 12, 0, 0);
  assert.equal(formatInstantFull(midnight.toISOString()), '10 Aug 2026 12:00:05 AM');
  assert.equal(formatInstantFull(noon.toISOString()), '10 Aug 2026 12:00:00 PM');
});

test('formatInstantFull: single-digit day and hour carry no leading zero, seconds are zero-padded', () => {
  const d = new Date(2026, 7, 2, 2, 5, 9);
  assert.equal(formatInstantFull(d.toISOString()), '2 Aug 2026 2:05:09 AM');
});

test('formatInstantFull: invalid input returns em dash', () => {
  assert.equal(formatInstantFull(''), '—');
  assert.equal(formatInstantFull('not-a-date'), '—');
});

// ---------------------------------------------------------------------
// formatDate
// ---------------------------------------------------------------------

test('formatDate: today, yesterday, tomorrow', () => {
  assert.equal(formatDate('2026-08-10', NOW), 'Today');
  assert.equal(formatDate('2026-08-09', NOW), 'Yesterday');
  assert.equal(formatDate('2026-08-11', NOW), 'Tomorrow');
});

test('formatDate: an older date and a further-future date render the absolute form, never a time', () => {
  assert.equal(formatDate('2026-08-01', NOW), '1 Aug 2026');
  assert.equal(formatDate('2026-08-15', NOW), '15 Aug 2026');
});

test('formatDate: single-digit day carries no leading zero', () => {
  assert.equal(formatDate('2026-08-02', NOW), '2 Aug 2026');
});

test('formatDate: invalid inputs return em dash', () => {
  assert.equal(formatDate('', NOW), '—');
  assert.equal(formatDate('not-a-date', NOW), '—');
  assert.equal(formatDate('2026-13-45', NOW), '—');
  assert.equal(formatDate('2026-02-31', NOW), '—'); // Feb has 28/29 days; must not roll over to Mar 3
});

test('formatDate: the UTC-midnight parsing trap — a manual local parse, not new Date(ymd)', () => {
  // In a negative-offset host timezone, `new Date('2026-08-10')` (parsed as
  // UTC midnight) reads back as Aug 9 local — one day early. formatDate
  // must not exhibit this, regardless of host offset.
  const original = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    // Sanity check the trap actually exists for the naive approach in this
    // TZ, so this test can't pass vacuously.
    assert.notEqual(new Date('2026-08-10').getDate(), 10);
    const now = new Date(2026, 7, 10, 22, 0, 0);
    assert.equal(formatDate('2026-08-10', now), 'Today');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

// ---------------------------------------------------------------------
// formatRelative
// ---------------------------------------------------------------------

function isoAt(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

test('formatRelative: past bucket edges', () => {
  assert.equal(formatRelative(isoAt(-59_000), NOW), 'just now');
  assert.equal(formatRelative(isoAt(-60_000), NOW), '1 minute ago');
  assert.equal(formatRelative(isoAt(-59 * 60_000), NOW), '59 minutes ago');
  assert.equal(formatRelative(isoAt(-60 * 60_000), NOW), '1 hour ago');
  assert.equal(formatRelative(isoAt(-23 * 3_600_000), NOW), '23 hours ago');
  assert.equal(formatRelative(isoAt(-24 * 3_600_000), NOW), '1 day ago');
});

test('formatRelative: future bucket edges', () => {
  assert.equal(formatRelative(isoAt(59_000), NOW), 'just now');
  assert.equal(formatRelative(isoAt(60_000), NOW), 'in 1 minute');
  assert.equal(formatRelative(isoAt(59 * 60_000), NOW), 'in 59 minutes');
  assert.equal(formatRelative(isoAt(60 * 60_000), NOW), 'in 1 hour');
  assert.equal(formatRelative(isoAt(23 * 3_600_000), NOW), 'in 23 hours');
  assert.equal(formatRelative(isoAt(24 * 3_600_000), NOW), 'in 1 day');
});

test('formatRelative: singular vs plural', () => {
  assert.equal(formatRelative(isoAt(-1 * 3_600_000), NOW), '1 hour ago');
  assert.equal(formatRelative(isoAt(-2 * 3_600_000), NOW), '2 hours ago');
  assert.equal(formatRelative(isoAt(-1 * 86_400_000), NOW), '1 day ago');
  assert.equal(formatRelative(isoAt(-2 * 86_400_000), NOW), '2 days ago');
});

test('formatRelative: invalid input returns em dash', () => {
  assert.equal(formatRelative('', NOW), '—');
  assert.equal(formatRelative('not-a-date', NOW), '—');
});

// ---------------------------------------------------------------------
// formatInstantTitle
// ---------------------------------------------------------------------

test('formatInstantTitle: composes the absolute form with the relative form via " · "', () => {
  const d = new Date(NOW.getTime() - 2 * 3_600_000);
  assert.equal(
    formatInstantTitle(d.toISOString(), NOW),
    `${formatInstantFull(d.toISOString())} · ${formatRelative(d.toISOString(), NOW)}`,
  );
  assert.equal(formatInstantTitle(d.toISOString(), NOW).includes(' · '), true);
});

// ---------------------------------------------------------------------
// Guard: datetime.ts is bundled into the browser SPA — it must import
// nothing at all, from anywhere.
// ---------------------------------------------------------------------

test('datetime.ts imports nothing (it is bundled into the browser SPA)', () => {
  const source = readFileSync(join(import.meta.dirname, 'datetime.ts'), 'utf8');
  assert.ok(source.length > 200, 'sanity: a missing/empty file must not pass vacuously');

  const importLines = source.split('\n').filter((line) => /^\s*import\s/.test(line));
  assert.deepEqual(importLines, []);
  assert.equal(/\bfrom\s+['"]/.test(source), false);

  const indexSource = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8');
  const specifiers = [...indexSource.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
    (m) => m[1],
  );
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) {
    assert.equal(specifier, './datetime.ts');
  }
});
