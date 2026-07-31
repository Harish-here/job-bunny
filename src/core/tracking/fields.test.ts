import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TrackingFieldsSchema } from './index.ts';

test('TrackingFieldsSchema: every field optional; empty object is valid', () => {
  assert.deepEqual(TrackingFieldsSchema.parse({}), {});
});

test('TrackingFieldsSchema: accepts the full manual-field set', () => {
  const full = {
    status: 'Applied',
    compRange: '30-40 LPA',
    notes: 'Referred by R.',
    contact: 'recruiter@acme.example',
    dateApplied: '2026-07-15',
    nextAction: 'Follow up',
    nextActionDate: '2026-08-05',
  };
  assert.deepEqual(TrackingFieldsSchema.parse(full), full);
});

test('TrackingFieldsSchema: date fields must be YYYY-MM-DD', () => {
  assert.throws(() => TrackingFieldsSchema.parse({ dateApplied: 'yesterday' }));
});
