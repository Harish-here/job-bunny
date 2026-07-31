import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PASSED_STATUS, STATUS_OPTIONS } from './index.ts';

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
