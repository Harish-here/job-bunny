import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteDeferredSlotStore } from './store.ts';

function freshDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-deferredstore-'));
  return path.join(dir, 'jobbunny.db');
}

function warnCollector(): { warn: (msg: string) => void; calls: string[] } {
  const calls: string[] = [];
  return { warn: (msg) => calls.push(msg), calls };
}

test('recordIfAbsent: two calls for the same (runDate, slot) produce exactly one row, retaining the first call', () => {
  const store = new SqliteDeferredSlotStore(freshDbPath());
  store.recordIfAbsent({
    runDate: '2026-08-10',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'first reason',
    decidedAt: '2026-08-10T09:00:01.000Z',
  });
  store.recordIfAbsent({
    runDate: '2026-08-10',
    slot: '09:00',
    reasonCode: 'network-unreachable',
    reason: 'second reason (should be ignored)',
    decidedAt: '2026-08-10T09:05:00.000Z',
  });

  const rows = store.listForDate('2026-08-10');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    runDate: '2026-08-10',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'first reason',
    decidedAt: '2026-08-10T09:00:01.000Z',
    notifiedAt: null,
  });
});

test('listForDate: returns rows for the requested date only, ordered by slot, [] for a date with no rows', () => {
  const store = new SqliteDeferredSlotStore(freshDbPath());
  store.recordIfAbsent({
    runDate: '2026-08-10',
    slot: '17:00',
    reasonCode: 'host-asleep',
    reason: 'late',
    decidedAt: '2026-08-10T17:00:00.000Z',
  });
  store.recordIfAbsent({
    runDate: '2026-08-10',
    slot: '09:00',
    reasonCode: 'daemon-unavailable',
    reason: 'early',
    decidedAt: '2026-08-10T09:00:00.000Z',
  });
  store.recordIfAbsent({
    runDate: '2026-08-11',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'other date',
    decidedAt: '2026-08-11T09:00:00.000Z',
  });

  const rows = store.listForDate('2026-08-10');
  assert.deepEqual(
    rows.map((r) => r.slot),
    ['09:00', '17:00'],
  );
  assert.deepEqual(store.listForDate('2026-08-12'), []);
});

test('listUnnotifiedDatesBefore: excludes dates >= beforeDate and dates fully markNotified', () => {
  const dbPath = freshDbPath();
  const store = new SqliteDeferredSlotStore(dbPath);
  // Date A: fully notified — excluded regardless of beforeDate.
  store.recordIfAbsent({
    runDate: '2026-08-08',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'a',
    decidedAt: '2026-08-08T09:00:00.000Z',
  });
  store.markNotified('2026-08-08', '2026-08-09T00:00:00.000Z');

  // Date B: partially notified — one row still unnotified, so it counts.
  store.recordIfAbsent({
    runDate: '2026-08-09',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'b1',
    decidedAt: '2026-08-09T09:00:00.000Z',
  });
  store.recordIfAbsent({
    runDate: '2026-08-09',
    slot: '17:00',
    reasonCode: 'network-unreachable',
    reason: 'b2',
    decidedAt: '2026-08-09T17:00:00.000Z',
  });
  // Notify only the 09:00 row for this date (partial notification — the
  // store's own markNotified always updates every row for a date, so a raw
  // connection to the same file is used here to set up the partial state).
  const rawDb = new DatabaseSync(dbPath);
  rawDb
    .prepare(
      "UPDATE deferred_slots SET notified_at = '2026-08-10T00:00:00.000Z' WHERE run_date = '2026-08-09' AND slot = '09:00'",
    )
    .run();
  rawDb.close();

  // Date C: none notified — included.
  store.recordIfAbsent({
    runDate: '2026-08-10',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'c',
    decidedAt: '2026-08-10T09:00:00.000Z',
  });

  // Date D: >= beforeDate — excluded even though unnotified.
  store.recordIfAbsent({
    runDate: '2026-08-11',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'd',
    decidedAt: '2026-08-11T09:00:00.000Z',
  });

  const dates = store.listUnnotifiedDatesBefore('2026-08-11');
  assert.deepEqual(dates, ['2026-08-09', '2026-08-10']);
});

test('markNotified: updates every row for the date and is idempotent', () => {
  const store = new SqliteDeferredSlotStore(freshDbPath());
  store.recordIfAbsent({
    runDate: '2026-08-10',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'a',
    decidedAt: '2026-08-10T09:00:00.000Z',
  });
  store.recordIfAbsent({
    runDate: '2026-08-10',
    slot: '17:00',
    reasonCode: 'network-unreachable',
    reason: 'b',
    decidedAt: '2026-08-10T17:00:00.000Z',
  });

  store.markNotified('2026-08-10', '2026-08-11T00:00:00.000Z');
  let rows = store.listForDate('2026-08-10');
  assert.deepEqual(
    rows.map((r) => r.notifiedAt),
    ['2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z'],
  );

  // Second call, same value — no-op, no error, no change.
  store.markNotified('2026-08-10', '2026-08-11T00:00:00.000Z');
  rows = store.listForDate('2026-08-10');
  assert.deepEqual(
    rows.map((r) => r.notifiedAt),
    ['2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z'],
  );
});

test('degraded mode: a store constructed against a bad path fails soft on every method', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-deferredstore-'));
  const blockerFile = path.join(dir, 'blocker');
  writeFileSync(blockerFile, 'not a directory');
  const dbPath = path.join(blockerFile, 'sub', 'jobbunny.db');
  const { warn, calls } = warnCollector();
  const store = new SqliteDeferredSlotStore(dbPath, { warn });

  store.recordIfAbsent({
    runDate: '2026-08-10',
    slot: '09:00',
    reasonCode: 'host-asleep',
    reason: 'x',
    decidedAt: '2026-08-10T09:00:00.000Z',
  });
  assert.equal(calls.length, 1);

  assert.deepEqual(store.listForDate('2026-08-10'), []);
  assert.deepEqual(store.listUnnotifiedDatesBefore('2026-08-11'), []);
  store.markNotified('2026-08-10', '2026-08-11T00:00:00.000Z');
  assert.equal(calls.length, 1);
});
