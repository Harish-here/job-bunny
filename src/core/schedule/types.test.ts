import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatLocalDate,
  hhMmToMinutes,
  localHhMm,
  parseRunFolderName,
} from './types.ts';

test('parseRunFolderName: a plain HH-MM folder parses to HH:MM', () => {
  assert.equal(parseRunFolderName('14-04'), '14:04');
});

test('parseRunFolderName: a collision-suffixed HH-MM-N folder strips the suffix', () => {
  assert.equal(parseRunFolderName('14-04-2'), '14:04');
});

test('parseRunFolderName: a non-run-folder name is undefined', () => {
  assert.equal(parseRunFolderName('sync_dryrun.json'), undefined);
});

test('parseRunFolderName: an unpadded single-digit hour is undefined (run_folder.ts always zero-pads)', () => {
  assert.equal(parseRunFolderName('9-00'), undefined);
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
