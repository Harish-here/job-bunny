import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCatchupSlots, encodeCatchupSlots } from './catchup.ts';

test('encodeCatchupSlots: undefined meta field -> null', () => {
  assert.equal(encodeCatchupSlots(undefined), null);
});

test('encodeCatchupSlots: an array -> its JSON string', () => {
  assert.equal(
    encodeCatchupSlots(['14:00', '16:30', '19:00']),
    '["14:00","16:30","19:00"]',
  );
});

test('encodeCatchupSlots: an empty array -> its JSON string, not null', () => {
  assert.equal(encodeCatchupSlots([]), '[]');
});

test('decodeCatchupSlots: null column -> null', () => {
  assert.equal(decodeCatchupSlots(null), null);
});

test('decodeCatchupSlots: a JSON string column -> the parsed array', () => {
  assert.deepEqual(decodeCatchupSlots('["14:00","16:30","19:00"]'), [
    '14:00',
    '16:30',
    '19:00',
  ]);
});

test('encode then decode round-trips', () => {
  const slots = ['09:00', '13:15'];
  assert.deepEqual(decodeCatchupSlots(encodeCatchupSlots(slots)), slots);
});
