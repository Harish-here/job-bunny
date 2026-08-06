import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatLocalDate, hhMmToMinutes, localHhMm, parseTimeDirSlot } from './types.ts';

test('parseTimeDirSlot: a plain HH-MM time_dir parses to HH:MM', () => {
  assert.equal(parseTimeDirSlot('14-04'), '14:04');
});

test('parseTimeDirSlot: a collision-suffixed HH-MM-N time_dir strips the suffix', () => {
  assert.equal(parseTimeDirSlot('14-04-2'), '14:04');
});

test('parseTimeDirSlot: a non-time_dir-shaped string is undefined', () => {
  assert.equal(parseTimeDirSlot('sync_dryrun.json'), undefined);
});

test('parseTimeDirSlot: an unpadded single-digit hour is undefined (formatRunTime always zero-pads)', () => {
  assert.equal(parseTimeDirSlot('9-00'), undefined);
});

test('formatLocalDate: formats a fixed local Date as YYYY-MM-DD', () => {
  assert.equal(formatLocalDate(new Date(2026, 6, 27, 14, 4)), '2026-07-27');
});

test('localHhMm: formats a fixed local Date as HH:MM', () => {
  assert.equal(localHhMm(new Date(2026, 6, 27, 14, 4)), '14:04');
});

test('localHhMm: zero-pads single-digit hour and minute', () => {
  assert.equal(localHhMm(new Date(2026, 6, 27, 9, 5)), '09:05');
});

test('hhMmToMinutes: converts HH:MM to minutes since local midnight', () => {
  assert.equal(hhMmToMinutes('00:00'), 0);
  assert.equal(hhMmToMinutes('14:04'), 844);
  assert.equal(hhMmToMinutes('23:59'), 1439);
});
