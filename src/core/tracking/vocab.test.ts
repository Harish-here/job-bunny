import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXCITEMENT_OPTIONS, PASSED_STATUS, STATUS_OPTIONS } from './index.ts';

test('STATUS_OPTIONS is the byte-exact v0 status vocabulary, in order', () => {
  assert.deepEqual(
    [...STATUS_OPTIONS],
    [
      'Lead',
      'Applied',
      'Recruiter Screen',
      'Tech Round',
      'Onsite',
      'Offer',
      'Rejected',
      'Passed',
    ],
  );
});

test('PASSED_STATUS is a member of STATUS_OPTIONS', () => {
  assert.ok((STATUS_OPTIONS as readonly string[]).includes(PASSED_STATUS));
});

test('EXCITEMENT_OPTIONS is the frozen 3-level vocabulary, high to low', () => {
  assert.deepEqual(
    [...EXCITEMENT_OPTIONS],
    ['Vera level', 'Kandipa podu', 'Try panalam'],
  );
});
