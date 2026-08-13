import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeferredSlotRow, DeferredSlotStore } from './deferred_slots.ts';

/** Minimal `Map`-backed fake — proves the interface's contract is
 * testable/enforceable even though the real enforcement (an `INSERT OR
 * IGNORE` against a unique index) is task 4's adapter, not this port. */
function fakeStore(): DeferredSlotStore {
  const rows = new Map<string, DeferredSlotRow>();
  const key = (runDate: string, slot: string) => `${runDate}|${slot}`;
  return {
    recordIfAbsent(entry) {
      const k = key(entry.runDate, entry.slot);
      if (rows.has(k)) return;
      rows.set(k, { ...entry, notifiedAt: null });
    },
    listForDate(runDate) {
      return [...rows.values()].filter((r) => r.runDate === runDate);
    },
    listUnnotifiedDatesBefore(beforeDate) {
      const dates = new Set<string>();
      for (const r of rows.values()) {
        if (r.runDate < beforeDate && r.notifiedAt === null) dates.add(r.runDate);
      }
      return [...dates].sort();
    },
    markNotified(runDate, notifiedAt) {
      for (const r of rows.values()) {
        if (r.runDate === runDate) r.notifiedAt = notifiedAt;
      }
    },
    close() {},
  };
}

test('recordIfAbsent is idempotent for the same (runDate, slot)', () => {
  const store = fakeStore();
  store.recordIfAbsent({
    runDate: '2026-08-13',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'host was asleep',
    decidedAt: '2026-08-13T09:31:00.000Z',
  });
  store.recordIfAbsent({
    runDate: '2026-08-13',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'host was asleep (second evaluation)',
    decidedAt: '2026-08-13T09:31:30.000Z',
  });
  assert.equal(store.listForDate('2026-08-13').length, 1);
  assert.equal(store.listForDate('2026-08-13')[0]?.reason, 'host was asleep');
});

test('listForDate filters by date', () => {
  const store = fakeStore();
  store.recordIfAbsent({
    runDate: '2026-08-13',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'host was asleep',
    decidedAt: '2026-08-13T09:31:00.000Z',
  });
  store.recordIfAbsent({
    runDate: '2026-08-12',
    slot: '14:00',
    reasonCode: 'network-unreachable',
    reason: 'no network',
    decidedAt: '2026-08-12T14:31:00.000Z',
  });
  assert.deepEqual(
    store.listForDate('2026-08-13').map((r) => r.slot),
    ['09:00'],
  );
  assert.deepEqual(
    store.listForDate('2026-08-12').map((r) => r.slot),
    ['14:00'],
  );
  assert.deepEqual(store.listForDate('2026-08-11'), []);
});

test('listUnnotifiedDatesBefore excludes dates >= beforeDate and fully-notified dates', () => {
  const store = fakeStore();
  store.recordIfAbsent({
    runDate: '2026-08-10',
    slot: '09:00',
    reasonCode: 'daemon-unavailable',
    reason: 'daemon down',
    decidedAt: '2026-08-10T09:31:00.000Z',
  });
  store.recordIfAbsent({
    runDate: '2026-08-11',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'host was asleep',
    decidedAt: '2026-08-11T09:31:00.000Z',
  });
  store.recordIfAbsent({
    runDate: '2026-08-13',
    slot: '09:00',
    reasonCode: 'network-unreachable',
    reason: 'no network',
    decidedAt: '2026-08-13T09:31:00.000Z',
  });
  // 2026-08-11 is fully notified already — must be excluded.
  store.markNotified('2026-08-11', '2026-08-11T20:00:00.000Z');

  const unnotified = store.listUnnotifiedDatesBefore('2026-08-13');
  assert.deepEqual(unnotified, ['2026-08-10']);
});

test('markNotified updates every row for a date', () => {
  const store = fakeStore();
  store.recordIfAbsent({
    runDate: '2026-08-13',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'host was asleep',
    decidedAt: '2026-08-13T09:31:00.000Z',
  });
  store.recordIfAbsent({
    runDate: '2026-08-13',
    slot: '14:00',
    reasonCode: 'network-unreachable',
    reason: 'no network',
    decidedAt: '2026-08-13T14:31:00.000Z',
  });
  assert.deepEqual(
    store.listForDate('2026-08-13').map((r) => r.notifiedAt),
    [null, null],
  );
  store.markNotified('2026-08-13', '2026-08-13T20:00:00.000Z');
  assert.deepEqual(
    store.listForDate('2026-08-13').map((r) => r.notifiedAt),
    ['2026-08-13T20:00:00.000Z', '2026-08-13T20:00:00.000Z'],
  );
  assert.deepEqual(store.listUnnotifiedDatesBefore('2026-08-14'), []);
});
