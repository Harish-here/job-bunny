import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveExpiredUnserved } from './deferrals.ts';
import type { ProfileSchedule, RunRecord } from './types.ts';

// 2026-07-27 is a Monday, matching owed.test.ts's own worked example.
function schedule(
  overrides: Partial<ProfileSchedule> & { profile: string },
): ProfileSchedule {
  return {
    enabled: true,
    times: ['09:00', '11:30', '14:00', '16:30', '19:00'],
    weekdays: [1, 2, 3, 4, 5],
    graceMinutes: 90,
    skipNext: null,
    ...overrides,
  };
}

test('a slot whose grace has NOT yet expired is excluded', () => {
  // 14:00 slot, graceMinutes 90 -> grace ends 15:30. 14:04 is well inside.
  const now = new Date(2026, 6, 27, 14, 4);
  const candidates = deriveExpiredUnserved(
    now,
    [schedule({ profile: 'harish', times: ['14:00'] })],
    [],
  );
  assert.deepEqual(candidates, []);
});

test('a served slot is excluded even though its grace has fully expired (R25)', () => {
  const now = new Date(2026, 6, 27, 15, 31); // grace ended at 15:30.
  const history: RunRecord[] = [
    { profile: 'harish', date: '2026-07-27', startedAt: '14:04' },
  ];
  const candidates = deriveExpiredUnserved(
    now,
    [schedule({ profile: 'harish', times: ['14:00'] })],
    history,
  );
  assert.deepEqual(candidates, []);
});

test('an expired, unserved slot is included exactly once in a single call', () => {
  const now = new Date(2026, 6, 27, 15, 31); // 14:00 slot's grace ended at 15:30.
  const candidates = deriveExpiredUnserved(
    now,
    [schedule({ profile: 'harish', times: ['14:00'] })],
    [],
  );
  assert.deepEqual(candidates, [
    {
      profile: 'harish',
      date: '2026-07-27',
      slot: '14:00',
      graceEndAt: new Date(2026, 6, 27, 15, 30),
    },
  ]);
});

test('repeated calls with identical inputs (simulating repeated ticks) return the same candidate every time', () => {
  const now = new Date(2026, 6, 27, 15, 31);
  const schedules = [schedule({ profile: 'harish', times: ['14:00'] })];
  const first = deriveExpiredUnserved(now, schedules, []);
  const second = deriveExpiredUnserved(now, schedules, []);
  const third = deriveExpiredUnserved(now, schedules, []);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
  assert.equal(first.length, 1);
});

test('a disabled profile never produces a candidate, even past grace', () => {
  const now = new Date(2026, 6, 27, 15, 31);
  const candidates = deriveExpiredUnserved(
    now,
    [schedule({ profile: 'harish', enabled: false })],
    [],
  );
  assert.deepEqual(candidates, []);
});

test('an off-weekday slot never produces a candidate, even past grace', () => {
  // 2026-08-01 is a Saturday; schedule is Mon-Fri only.
  const now = new Date(2026, 7, 1, 15, 31);
  const candidates = deriveExpiredUnserved(now, [schedule({ profile: 'harish' })], []);
  assert.deepEqual(candidates, []);
});

test('a profile with multiple owed-and-expired slots returns one candidate per slot', () => {
  // 09:00 and 11:30 slots both have 90min grace, both long expired by 19:01.
  const now = new Date(2026, 6, 27, 19, 1); // 19:00 slot still inside its own grace.
  const candidates = deriveExpiredUnserved(
    now,
    [schedule({ profile: 'harish', times: ['09:00', '11:30', '19:00'] })],
    [],
  );
  assert.deepEqual(candidates, [
    {
      profile: 'harish',
      date: '2026-07-27',
      slot: '09:00',
      graceEndAt: new Date(2026, 6, 27, 10, 30),
    },
    {
      profile: 'harish',
      date: '2026-07-27',
      slot: '11:30',
      graceEndAt: new Date(2026, 6, 27, 13, 0),
    },
  ]);
});

test('grace boundary is strictly-greater-than: now exactly at graceEndAt is still excluded', () => {
  const now = new Date(2026, 6, 27, 15, 30); // exactly graceEndAt for the 14:00 slot.
  const candidates = deriveExpiredUnserved(
    now,
    [schedule({ profile: 'harish', times: ['14:00'] })],
    [],
  );
  assert.deepEqual(candidates, []);
});

test('a skipNext-suppressed slot is excluded even once its grace has fully closed unserved (mirrors isRunOwed)', () => {
  const now = new Date(2026, 6, 27, 15, 31); // 14:00 slot's grace ended at 15:30.
  const candidates = deriveExpiredUnserved(
    now,
    [
      schedule({
        profile: 'harish',
        times: ['14:00'],
        skipNext: { date: '2026-07-27', slot: '14:00' },
      }),
    ],
    [],
  );
  assert.deepEqual(candidates, []);
});

test('skipNext for a DIFFERENT slot does not suppress this slot from being reported expired-unserved', () => {
  const now = new Date(2026, 6, 27, 15, 31); // 14:00 slot's grace ended at 15:30.
  const candidates = deriveExpiredUnserved(
    now,
    [
      schedule({
        profile: 'harish',
        times: ['14:00'],
        skipNext: { date: '2026-07-27', slot: '11:30' },
      }),
    ],
    [],
  );
  assert.deepEqual(candidates, [
    {
      profile: 'harish',
      date: '2026-07-27',
      slot: '14:00',
      graceEndAt: new Date(2026, 6, 27, 15, 30),
    },
  ]);
});
