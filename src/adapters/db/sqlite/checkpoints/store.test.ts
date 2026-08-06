import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openJobsDb } from '../store/index.ts';
import { SqliteCheckpointStore } from './store.ts';

function freshDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-checkpointstore-'));
  return path.join(dir, 'jobbunny.db');
}

test('write + readLatest round-trip a single checkpoint', () => {
  const dbPath = freshDbPath();
  const store = new SqliteCheckpointStore(dbPath);
  store.write(
    { runDate: '2026-08-05', timeDir: '10-00', position: 0, stage: 'farm' },
    { jobs: [1, 2], dropped: [] },
  );
  const latest = store.readLatest('2026-08-05', '10-00');
  assert.ok(latest);
  assert.deepEqual(latest.ref, {
    runDate: '2026-08-05',
    timeDir: '10-00',
    position: 0,
    stage: 'farm',
  });
  assert.deepEqual(latest.payload, { jobs: [1, 2], dropped: [] });
});

test('slot overwrite: writing the same (runDate, timeDir, position) twice keeps the second write', () => {
  const dbPath = freshDbPath();
  const store = new SqliteCheckpointStore(dbPath);
  store.write(
    { runDate: '2026-08-05', timeDir: '10-00', position: 0, stage: 'farm' },
    { jobs: [1] },
  );
  store.write(
    { runDate: '2026-08-05', timeDir: '10-00', position: 0, stage: 'source' },
    { jobs: [1, 2, 3] },
  );
  const latest = store.readLatest('2026-08-05', '10-00');
  assert.equal(latest?.ref.stage, 'source');
  assert.deepEqual(latest?.payload, { jobs: [1, 2, 3] });
});

test('readLatest picks the highest position when multiple exist in one group', () => {
  const dbPath = freshDbPath();
  const store = new SqliteCheckpointStore(dbPath);
  store.write(
    { runDate: '2026-08-05', timeDir: '10-00', position: 2, stage: 'rank' },
    { n: 2 },
  );
  store.write(
    { runDate: '2026-08-05', timeDir: '10-00', position: 0, stage: 'farm' },
    { n: 0 },
  );
  store.write(
    { runDate: '2026-08-05', timeDir: '10-00', position: 1, stage: 'source' },
    { n: 1 },
  );
  const latest = store.readLatest('2026-08-05', '10-00');
  assert.equal(latest?.ref.position, 2);
  assert.deepEqual(latest?.payload, { n: 2 });
});

test('readLatest returns undefined for a group with no rows', () => {
  const dbPath = freshDbPath();
  const store = new SqliteCheckpointStore(dbPath);
  assert.equal(store.readLatest('2026-08-05', '10-00'), undefined);
});

test('latestTimeDir: a collision-suffix group sorts after its bare HH-MM', () => {
  const dbPath = freshDbPath();
  const store = new SqliteCheckpointStore(dbPath);
  store.write(
    { runDate: '2026-08-05', timeDir: '10-43', position: 0, stage: 'farm' },
    { n: 0 },
  );
  store.write(
    { runDate: '2026-08-05', timeDir: '10-43-2', position: 0, stage: 'farm' },
    { n: 0 },
  );
  assert.equal(store.latestTimeDir('2026-08-05'), '10-43-2');
});

test('latestTimeDir/nextTimeDir: a runs-row-only group still occupies its slot', () => {
  const dbPath = freshDbPath();
  const db = openJobsDb(dbPath);
  db.prepare(
    `INSERT INTO runs (run_date, time_dir, kind, status, started_at)
     VALUES (?, ?, 'run', 'running', ?)`,
  ).run('2026-08-05', '11-00', '2026-08-05T11:00:00.000Z');
  db.close();

  const store = new SqliteCheckpointStore(dbPath);
  assert.equal(store.latestTimeDir('2026-08-05'), '11-00');
  assert.equal(store.nextTimeDir('2026-08-05', '11-00'), '11-00-2');
});

test('latestCheckpointTimeDir: a bare runs-row group is skipped in favor of the last group with an actual checkpoint', () => {
  const dbPath = freshDbPath();
  const store = new SqliteCheckpointStore(dbPath);
  store.write(
    { runDate: '2026-08-05', timeDir: '07-00', position: 2, stage: 'rank' },
    { n: 'checkpointed' },
  );
  const db = openJobsDb(dbPath);
  db.prepare(
    `INSERT INTO runs (run_date, time_dir, kind, status, started_at)
     VALUES (?, ?, 'run', 'running', ?)`,
  ).run('2026-08-05', '08-00', '2026-08-05T08:00:00.000Z'); // opened, no checkpoint yet.
  db.close();

  // The union-based `latestTimeDir` (collision-avoidance only) is shadowed
  // by the bare runs-row — this is exactly why resume/chain-continuation
  // must never call it.
  assert.equal(store.latestTimeDir('2026-08-05'), '08-00');
  assert.equal(store.latestCheckpointTimeDir('2026-08-05'), '07-00');
});

test('latestCheckpointTimeDir: undefined when the date has no checkpoints at all, even with runs rows present', () => {
  const dbPath = freshDbPath();
  const db = openJobsDb(dbPath);
  db.prepare(
    `INSERT INTO runs (run_date, time_dir, kind, status, started_at)
     VALUES (?, ?, 'run', 'running', ?)`,
  ).run('2026-08-05', '09-00', '2026-08-05T09:00:00.000Z');
  db.close();

  const store = new SqliteCheckpointStore(dbPath);
  assert.equal(store.latestCheckpointTimeDir('2026-08-05'), undefined);
});

test('nextTimeDir: collision suffixes increment past multiple existing groups', () => {
  const dbPath = freshDbPath();
  const store = new SqliteCheckpointStore(dbPath);
  store.write(
    { runDate: '2026-08-05', timeDir: '09-05', position: 0, stage: 'farm' },
    { n: 0 },
  );
  store.write(
    { runDate: '2026-08-05', timeDir: '09-05-2', position: 0, stage: 'farm' },
    { n: 0 },
  );
  store.write(
    { runDate: '2026-08-05', timeDir: '09-05-3', position: 0, stage: 'farm' },
    { n: 0 },
  );
  assert.equal(store.nextTimeDir('2026-08-05', '09-05'), '09-05-4');
});

test('loud posture: a broken db path throws instead of degrading', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jb-checkpointstore-'));
  const blockerFile = path.join(dir, 'blocker');
  writeFileSync(blockerFile, 'not a directory');
  const dbPath = path.join(blockerFile, 'sub', 'jobbunny.db');
  const store = new SqliteCheckpointStore(dbPath);
  assert.throws(() =>
    store.write(
      { runDate: '2026-08-05', timeDir: '10-00', position: 0, stage: 'farm' },
      { n: 0 },
    ),
  );
});

test('pruneOlderThan: exactly-TTL kept, one day older deleted', () => {
  const dbPath = freshDbPath();
  const store = new SqliteCheckpointStore(dbPath);
  store.write(
    { runDate: '2026-07-06', timeDir: '10-00', position: 0, stage: 'farm' },
    { n: 'kept' },
  );
  store.write(
    { runDate: '2026-07-05', timeDir: '10-00', position: 0, stage: 'farm' },
    { n: 'deleted' },
  );
  const deleted = store.pruneOlderThan('2026-08-05', 30);
  assert.equal(deleted, 1);
  const kept = store.readLatest('2026-07-06', '10-00');
  assert.deepEqual(kept?.payload, { n: 'kept' });
  assert.equal(store.readLatest('2026-07-05', '10-00'), undefined);
});

test('lazy open: constructing the store performs no file I/O', () => {
  const dbPath = freshDbPath();
  new SqliteCheckpointStore(dbPath);
  assert.equal(existsSync(dbPath), false);
});
