import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deriveStatus, RUN_HEARTBEAT_STALE_MS, SqliteRunStore } from './store.ts';

function freshDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-runstore-'));
  return path.join(dir, 'jobbunny.db');
}

function warnCollector(): { warn: (msg: string) => void; calls: string[] } {
  const calls: string[] = [];
  return { warn: (msg) => calls.push(msg), calls };
}

test('lazy open: constructor performs no file I/O', () => {
  const dbPath = freshDbPath();
  new SqliteRunStore(dbPath);
  assert.equal(existsSync(dbPath), false);
});

test('first writer call opens the db lazily', () => {
  const dbPath = freshDbPath();
  const store = new SqliteRunStore(dbPath);
  assert.equal(existsSync(dbPath), false);
  store.startRun({
    date: '2026-08-05',
    kind: 'run',
    startedAt: '2026-08-05T10:00:00.000Z',
  });
  assert.equal(existsSync(dbPath), true);
});

test('degraded mode: open failure warns once and permanently no-ops', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-runstore-'));
  const blockerFile = path.join(dir, 'blocker');
  writeFileSync(blockerFile, 'not a directory');
  const dbPath = path.join(blockerFile, 'sub', 'jobbunny.db');
  const { warn, calls } = warnCollector();
  const store = new SqliteRunStore(dbPath, { warn });

  assert.equal(
    store.startRun({
      date: '2026-08-05',
      kind: 'run',
      startedAt: '2026-08-05T10:00:00.000Z',
    }),
    -1,
  );
  assert.equal(calls.length, 1);

  // Further calls stay silent (no throw, no second warn).
  store.appendEvents(1, [{ ts: '2026-08-05T10:00:00.000Z', level: 'info', msg: 'x' }]);
  store.heartbeat(1, '2026-08-05T10:00:01.000Z');
  store.recordFailure(1, { stage: 'x', error: 'y', elapsedMs: 1 });
  store.recordSyncDryrun(1, { ok: true });
  store.finishRun(1, 'failed', {}, '2026-08-05T10:01:00.000Z');
  assert.deepEqual(store.listRuns(), []);
  assert.equal(store.getRun(1), null);
  assert.deepEqual(store.listEvents(1), []);
  assert.equal(store.findRunId('2026-08-05', '10-00'), null);
  assert.equal(store.pruneRunsOlderThan('2026-08-05', 30), 0);
  assert.equal(calls.length, 1);
});

test('fail-soft writers: a runtime SQL error warns once and never throws', () => {
  const dbPath = freshDbPath();
  const { warn, calls } = warnCollector();
  const store = new SqliteRunStore(dbPath, { warn });
  // run_id 999 does not exist -> FK violation on insert, caught not thrown.
  assert.doesNotThrow(() => {
    store.appendEvents(999, [
      { ts: '2026-08-05T10:00:00.000Z', level: 'info', msg: 'x' },
    ]);
  });
  assert.equal(calls.length, 1);
  // A second failure does not add a second warning (single warned flag).
  assert.doesNotThrow(() => {
    store.appendEvents(999, [
      { ts: '2026-08-05T10:00:01.000Z', level: 'info', msg: 'y' },
    ]);
  });
  assert.equal(calls.length, 1);
});

test('a writer called with runId === -1 is a silent no-op', () => {
  const dbPath = freshDbPath();
  const { warn, calls } = warnCollector();
  const store = new SqliteRunStore(dbPath, { warn });
  store.appendEvents(-1, [{ ts: '2026-08-05T10:00:00.000Z', level: 'info', msg: 'x' }]);
  store.heartbeat(-1, '2026-08-05T10:00:00.000Z');
  store.recordFailure(-1, { stage: 'x', error: 'y', elapsedMs: 1 });
  store.recordSyncDryrun(-1, { ok: true });
  store.finishRun(-1, 'failed', {}, '2026-08-05T10:00:00.000Z');
  assert.equal(calls.length, 0);
  // No db file should have been created — nothing ever opened.
  assert.equal(existsSync(dbPath), false);
});

test('startRun: inserts a running row and tidies prior stale running rows', () => {
  const dbPath = freshDbPath();
  const now = () => new Date('2026-08-05T12:00:00.000Z');
  const storeA = new SqliteRunStore(dbPath, { now });
  const staleId = storeA.startRun({
    date: '2026-08-05',
    kind: 'run',
    startedAt: '2026-08-05T01:00:00.000Z',
  });
  // Give it an old heartbeat, well past the 10-minute staleness window.
  storeA.heartbeat(staleId, '2026-08-05T01:05:00.000Z');
  storeA.close();

  const storeB = new SqliteRunStore(dbPath, { now });
  const newId = storeB.startRun({
    date: '2026-08-05',
    kind: 'run',
    startedAt: '2026-08-05T12:00:00.000Z',
  });
  // A fresh row has no heartbeat yet, so it displays as crashed (null
  // counts as stale, per contract) until the driver's first heartbeat —
  // simulate that here.
  storeB.heartbeat(newId, '2026-08-05T12:00:00.000Z');
  assert.notEqual(newId, staleId);

  const runs = storeB.listRuns();
  const staleRow = runs.find((r) => r.id === staleId);
  assert.ok(staleRow);
  assert.equal(staleRow.status, 'crashed');
  const newRow = runs.find((r) => r.id === newId);
  assert.ok(newRow);
  assert.equal(newRow.status, 'running');
});

test('appendEvents: batched insert in one transaction, bumps heartbeat to max event ts', () => {
  const dbPath = freshDbPath();
  const store = new SqliteRunStore(dbPath);
  const runId = store.startRun({
    date: '2026-08-05',
    kind: 'stage',
    startedAt: '2026-08-05T10:00:00.000Z',
  });
  store.appendEvents(runId, [
    { ts: '2026-08-05T10:00:05.000Z', level: 'info', msg: 'first' },
    { ts: '2026-08-05T10:00:10.000Z', level: 'warn', msg: 'second', data: { n: 1 } },
  ]);
  const events = store.listEvents(runId);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.msg, 'first');
  assert.equal(events[1]?.msg, 'second');
  assert.deepEqual(events[1]?.data, { n: 1 });

  const detail = store.getRun(runId);
  assert.equal(detail?.heartbeatAt, '2026-08-05T10:00:10.000Z');
});

test('finishRun: sets status, result_json, finished_at', () => {
  const dbPath = freshDbPath();
  const store = new SqliteRunStore(dbPath);
  const runId = store.startRun({
    date: '2026-08-05',
    kind: 'run',
    startedAt: '2026-08-05T10:00:00.000Z',
  });
  store.finishRun(
    runId,
    'passed',
    { funnel: { in: 5, out: 3 } },
    '2026-08-05T10:05:00.000Z',
  );
  const detail = store.getRun(runId);
  assert.equal(detail?.status, 'passed');
  assert.deepEqual(detail?.result, { funnel: { in: 5, out: 3 } });
  assert.equal(detail?.finishedAt, '2026-08-05T10:05:00.000Z');
});

test('recordFailure / recordSyncDryrun write their JSON blob columns', () => {
  const dbPath = freshDbPath();
  const store = new SqliteRunStore(dbPath);
  const runId = store.startRun({
    date: '2026-08-05',
    kind: 'run',
    startedAt: '2026-08-05T10:00:00.000Z',
  });
  store.recordFailure(runId, { stage: 'farm', error: 'boom', elapsedMs: 123 });
  store.recordSyncDryrun(runId, { wouldSync: 2 });
  const detail = store.getRun(runId);
  assert.deepEqual(detail?.failure, { stage: 'farm', error: 'boom', elapsedMs: 123 });
  assert.deepEqual(detail?.syncDryrun, { wouldSync: 2 });
});

test('listRuns: newest first, default limit 50, maps snake_case to camelCase', () => {
  const dbPath = freshDbPath();
  const store = new SqliteRunStore(dbPath);
  const id1 = store.startRun({
    date: '2026-08-04',
    timeDir: '09-00',
    kind: 'run',
    startedAt: '2026-08-04T09:00:00.000Z',
  });
  const id2 = store.startRun({
    date: '2026-08-05',
    timeDir: '10-00',
    kind: 'stage',
    resumedFrom: id1,
    startedAt: '2026-08-05T10:00:00.000Z',
  });
  const runs = store.listRuns();
  assert.deepEqual(
    runs.map((r) => r.id),
    [id2, id1],
  );
  const row = runs[0];
  assert.equal(row?.date, '2026-08-05');
  assert.equal(row?.timeDir, '10-00');
  assert.equal(row?.kind, 'stage');
  assert.equal(row?.resumedFrom, id1);
});

test('getRun: blobs JSON.parsed back to unknown; null column -> null', () => {
  const dbPath = freshDbPath();
  const store = new SqliteRunStore(dbPath);
  const runId = store.startRun({
    date: '2026-08-05',
    kind: 'run',
    startedAt: '2026-08-05T10:00:00.000Z',
  });
  const detail = store.getRun(runId);
  assert.equal(detail?.result, null);
  assert.equal(detail?.failure, null);
  assert.equal(detail?.syncDryrun, null);
});

test('getRun: unknown id returns null', () => {
  const dbPath = freshDbPath();
  const store = new SqliteRunStore(dbPath);
  store.startRun({
    date: '2026-08-05',
    kind: 'run',
    startedAt: '2026-08-05T10:00:00.000Z',
  });
  assert.equal(store.getRun(9999), null);
});

test('listEvents: ascending by id, default limit 500, data_json parsed', () => {
  const dbPath = freshDbPath();
  const store = new SqliteRunStore(dbPath);
  const runId = store.startRun({
    date: '2026-08-05',
    kind: 'run',
    startedAt: '2026-08-05T10:00:00.000Z',
  });
  store.appendEvents(runId, [
    { ts: '2026-08-05T10:00:01.000Z', level: 'debug', msg: 'a' },
    { ts: '2026-08-05T10:00:02.000Z', level: 'info', msg: 'b', data: { x: 1 } },
    { ts: '2026-08-05T10:00:03.000Z', level: 'error', msg: 'c' },
  ]);
  const events = store.listEvents(runId);
  assert.deepEqual(
    events.map((e) => e.msg),
    ['a', 'b', 'c'],
  );
  assert.equal(events[0]?.data, undefined);
  assert.deepEqual(events[1]?.data, { x: 1 });
});

test('findRunId: matches run_date + time_dir, newest first', () => {
  const dbPath = freshDbPath();
  const store = new SqliteRunStore(dbPath);
  const id1 = store.startRun({
    date: '2026-08-05',
    timeDir: '10-00',
    kind: 'run',
    startedAt: '2026-08-05T10:00:00.000Z',
  });
  const id2 = store.startRun({
    date: '2026-08-05',
    timeDir: '10-00',
    kind: 'run',
    startedAt: '2026-08-05T10:00:01.000Z',
  });
  assert.equal(store.findRunId('2026-08-05', '10-00'), id2);
  assert.notEqual(id1, id2);
  assert.equal(store.findRunId('2026-08-05', '11-00'), null);
});

test('listRunTimeDirs: distinct time_dirs for the given date, across every kind', () => {
  const dbPath = freshDbPath();
  const store = new SqliteRunStore(dbPath);
  store.startRun({
    date: '2026-08-05',
    timeDir: '10-00',
    kind: 'run',
    startedAt: '2026-08-05T10:00:00.000Z',
  });
  store.startRun({
    date: '2026-08-05',
    timeDir: '10-00',
    kind: 'run',
    startedAt: '2026-08-05T10:00:01.000Z',
  }); // same time_dir as above — must appear only once (DISTINCT).
  store.startRun({
    date: '2026-08-05',
    timeDir: '11-30',
    kind: 'stage',
    startedAt: '2026-08-05T11:30:00.000Z',
  });
  store.startRun({
    date: '2026-08-04',
    timeDir: '09-00',
    kind: 'run',
    startedAt: '2026-08-04T09:00:00.000Z',
  }); // a different date — must not appear.

  assert.deepEqual(store.listRunTimeDirs('2026-08-05').sort(), ['10-00', '11-30']);
});

test('listRunTimeDirs: a date with no rows yields []', () => {
  const dbPath = freshDbPath();
  const store = new SqliteRunStore(dbPath);
  assert.deepEqual(store.listRunTimeDirs('2026-08-05'), []);
});

test('listRunTimeDirs: fail-soft — a degraded store (bad db path) returns [] instead of throwing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-runstore-'));
  const blockerFile = path.join(dir, 'blocker');
  writeFileSync(blockerFile, 'not a directory');
  const dbPath = path.join(blockerFile, 'sub', 'jobbunny.db');
  const store = new SqliteRunStore(dbPath, { warn: () => {} });
  assert.deepEqual(store.listRunTimeDirs('2026-08-05'), []);
});

test('pruneRunsOlderThan: deletes strictly-older runs + their events, never today, returns runs-deleted count', () => {
  const dbPath = freshDbPath();
  const store = new SqliteRunStore(dbPath);
  const oldId = store.startRun({
    date: '2026-07-01',
    kind: 'run',
    startedAt: '2026-07-01T10:00:00.000Z',
  });
  store.appendEvents(oldId, [
    { ts: '2026-07-01T10:00:01.000Z', level: 'info', msg: 'old' },
  ]);
  const todayId = store.startRun({
    date: '2026-08-05',
    kind: 'run',
    startedAt: '2026-08-05T10:00:00.000Z',
  });

  const deleted = store.pruneRunsOlderThan('2026-08-05', 30);
  assert.equal(deleted, 1);
  assert.equal(store.getRun(oldId), null);
  assert.deepEqual(store.listEvents(oldId), []);
  assert.ok(store.getRun(todayId));
});

test('pruneRunsOlderThan: never prunes today even at ttlDays 0', () => {
  const dbPath = freshDbPath();
  const store = new SqliteRunStore(dbPath);
  const todayId = store.startRun({
    date: '2026-08-05',
    kind: 'run',
    startedAt: '2026-08-05T10:00:00.000Z',
  });
  const deleted = store.pruneRunsOlderThan('2026-08-05', 0);
  assert.equal(deleted, 0);
  assert.ok(store.getRun(todayId));
});

test('pruneRunsOlderThan: an old parent with a RETAINED child (split resumedFrom chain) still prunes the parent — resumed_from -> NULL via ON DELETE SET NULL, never an all-or-nothing FK failure', () => {
  const dbPath = freshDbPath();
  const { warn, calls } = warnCollector();
  const store = new SqliteRunStore(dbPath, { warn });
  const parentId = store.startRun({
    date: '2026-07-01',
    kind: 'run',
    startedAt: '2026-07-01T10:00:00.000Z',
  });
  const childId = store.startRun({
    date: '2026-08-05',
    kind: 'run',
    resumedFrom: parentId,
    startedAt: '2026-08-05T10:00:00.000Z',
  });

  const deleted = store.pruneRunsOlderThan('2026-08-05', 30);

  assert.equal(deleted, 1);
  assert.deepEqual(calls, []);
  assert.equal(store.getRun(parentId), null);
  const child = store.getRun(childId);
  assert.ok(child);
  assert.equal(child?.resumedFrom, null);
});

test('full happy path: startRun -> appendEvents x2 -> recordFailure -> finishRun(failed) -> round-trip every field', () => {
  const dbPath = freshDbPath();
  const store = new SqliteRunStore(dbPath);
  const runId = store.startRun({
    date: '2026-08-05',
    timeDir: '10-00',
    kind: 'run',
    startedAt: '2026-08-05T10:00:00.000Z',
  });
  store.appendEvents(runId, [
    { ts: '2026-08-05T10:00:05.000Z', level: 'info', msg: 'first' },
  ]);
  store.appendEvents(runId, [
    { ts: '2026-08-05T10:00:10.000Z', level: 'error', msg: 'second', data: { err: 'x' } },
  ]);
  store.recordFailure(runId, { stage: 'source', error: 'boom', elapsedMs: 999 });
  store.finishRun(runId, 'failed', { funnel: {} }, '2026-08-05T10:00:15.000Z');

  const runs = store.listRuns();
  assert.equal(runs.length, 1);
  const summary = runs[0];
  assert.equal(summary?.id, runId);
  assert.equal(summary?.date, '2026-08-05');
  assert.equal(summary?.timeDir, '10-00');
  assert.equal(summary?.kind, 'run');
  assert.equal(summary?.resumedFrom, null);
  assert.equal(summary?.status, 'failed');
  assert.equal(summary?.startedAt, '2026-08-05T10:00:00.000Z');
  assert.equal(summary?.finishedAt, '2026-08-05T10:00:15.000Z');
  assert.equal(summary?.heartbeatAt, '2026-08-05T10:00:10.000Z');

  const detail = store.getRun(runId);
  assert.deepEqual(detail?.result, { funnel: {} });
  assert.deepEqual(detail?.failure, { stage: 'source', error: 'boom', elapsedMs: 999 });
  assert.equal(detail?.syncDryrun, null);

  const events = store.listEvents(runId);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.msg, 'first');
  assert.deepEqual(events[1]?.data, { err: 'x' });

  assert.equal(store.findRunId('2026-08-05', '10-00'), runId);
});

test('RUN_HEARTBEAT_STALE_MS is 10 minutes', () => {
  assert.equal(RUN_HEARTBEAT_STALE_MS, 10 * 60_000);
});

test('deriveStatus: non-running statuses pass through unchanged regardless of heartbeat', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');
  assert.equal(deriveStatus('passed', null, now), 'passed');
  assert.equal(deriveStatus('failed', '2020-01-01T00:00:00.000Z', now), 'failed');
  assert.equal(deriveStatus('crashed', null, now), 'crashed');
});

test('deriveStatus: running with a null heartbeat is crashed', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');
  assert.equal(deriveStatus('running', null, now), 'crashed');
});

test('deriveStatus: running with a stale heartbeat (> 10min old) is crashed', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');
  assert.equal(deriveStatus('running', '2026-08-05T11:49:00.000Z', now), 'crashed');
});

test('deriveStatus: running with a fresh heartbeat (<= 10min old) stays running', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');
  assert.equal(deriveStatus('running', '2026-08-05T11:51:00.000Z', now), 'running');
});
