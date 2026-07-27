import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRunOwed, nextFireAt } from './owed.ts';
import type { ProfileSchedule, RunRecord } from './types.ts';

// 2026-07-27 is a Monday, matching the incident this design fixes.
function schedule(
  overrides: Partial<ProfileSchedule> & { profile: string },
): ProfileSchedule {
  return {
    enabled: true,
    times: ['09:00', '11:30', '14:00', '16:30', '19:00'],
    weekdays: [1, 2, 3, 4, 5],
    graceMinutes: 90,
    ...overrides,
  };
}

test('worked example: the 14:00 slot is owed at 14:04 with no run folder yet', () => {
  const now = new Date(2026, 6, 27, 14, 4);
  const owed = isRunOwed(now, [schedule({ profile: 'harish' })], []);
  assert.deepEqual(owed, [{ profile: 'harish', date: '2026-07-27', slot: '14:00' }]);
});

test('worked example: the 14:00 slot is no longer owed once a RunRecord falls in its window', () => {
  const now = new Date(2026, 6, 27, 14, 4);
  const history: RunRecord[] = [
    { profile: 'harish', date: '2026-07-27', startedAt: '14:04' },
  ];
  const owed = isRunOwed(now, [schedule({ profile: 'harish' })], history);
  assert.deepEqual(owed, []);
});

test('worked example: at 15:45 with no record, the 14:00 slot is NOT owed (grace expired at 15:30)', () => {
  const now = new Date(2026, 6, 27, 15, 45);
  const owed = isRunOwed(now, [schedule({ profile: 'harish' })], []);
  assert.deepEqual(owed, []);
});

test('a disabled profile returns nothing, even inside its grace window', () => {
  const now = new Date(2026, 6, 27, 14, 4);
  const owed = isRunOwed(now, [schedule({ profile: 'harish', enabled: false })], []);
  assert.deepEqual(owed, []);
});

test('a Saturday returns nothing for a Mon-Fri schedule', () => {
  // 2026-08-01 is a Saturday.
  const now = new Date(2026, 7, 1, 14, 4);
  const owed = isRunOwed(now, [schedule({ profile: 'harish' })], []);
  assert.deepEqual(owed, []);
});

test('two profiles sharing a slot both return, sorted by (slot, profileName)', () => {
  const now = new Date(2026, 6, 27, 14, 4);
  const owed = isRunOwed(
    now,
    [schedule({ profile: 'rajni' }), schedule({ profile: 'harish' })],
    [],
  );
  assert.deepEqual(owed, [
    { profile: 'harish', date: '2026-07-27', slot: '14:00' },
    { profile: 'rajni', date: '2026-07-27', slot: '14:00' },
  ]);
});

test('a profile whose graceMinutes exceeds its own inter-slot gap can have two slots owed at once', () => {
  const now = new Date(2026, 6, 27, 11, 35);
  const owed = isRunOwed(
    now,
    [schedule({ profile: 'harish', times: ['09:00', '11:30'], graceMinutes: 200 })],
    [],
  );
  assert.deepEqual(owed, [
    { profile: 'harish', date: '2026-07-27', slot: '09:00' },
    { profile: 'harish', date: '2026-07-27', slot: '11:30' },
  ]);
});

test('nextFireAt returns the earliest strictly-future slot', () => {
  const now = new Date(2026, 6, 27, 10, 0);
  const result = nextFireAt(now, [schedule({ profile: 'harish' })]);
  assert.equal(result?.at.getTime(), new Date(2026, 6, 27, 11, 30).getTime());
  assert.deepEqual(result?.runs, [
    { profile: 'harish', date: '2026-07-27', slot: '11:30' },
  ]);
});

test('nextFireAt never returns a slot that has already arrived, even if still unserved', () => {
  const now = new Date(2026, 6, 27, 14, 4);
  const result = nextFireAt(now, [schedule({ profile: 'harish' })]);
  assert.equal(result?.runs[0]?.slot, '16:30'); // 14:00 already arrived — not "next".
});

test('nextFireAt returns null when no schedule has a future slot today', () => {
  const now = new Date(2026, 6, 27, 20, 0);
  const result = nextFireAt(now, [schedule({ profile: 'harish' })]);
  assert.equal(result, null);
});

test('nextFireAt groups multiple profiles sharing the identical next slot, sorted by profile', () => {
  const now = new Date(2026, 6, 27, 10, 0);
  const result = nextFireAt(now, [
    schedule({ profile: 'rajni' }),
    schedule({ profile: 'harish' }),
  ]);
  assert.deepEqual(result?.runs, [
    { profile: 'harish', date: '2026-07-27', slot: '11:30' },
    { profile: 'rajni', date: '2026-07-27', slot: '11:30' },
  ]);
});
