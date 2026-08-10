import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openJobsDb } from '../store/index.ts';
import { mapProgressRow, progressRowValues, UPSERT_PROGRESS_SQL } from './progress.ts';

function dbWithRun(): { db: ReturnType<typeof openJobsDb>; runId: number } {
  const db = openJobsDb(':memory:');
  const result = db
    .prepare(
      `INSERT INTO runs (run_date, time_dir, kind, status, started_at)
       VALUES ('2026-08-10', '09-00', 'run', 'running', '2026-08-10T09:00:00.000Z')`,
    )
    .run();
  return { db, runId: Number(result.lastInsertRowid) };
}

test('UPSERT_PROGRESS_SQL run twice for the same run_id updates in place', () => {
  const { db, runId } = dbWithRun();

  db.prepare(UPSERT_PROGRESS_SQL).run(
    ...progressRowValues(runId, {
      stage: 'farm',
      stageIndex: 2,
      stageTotal: 10,
      stageStartedAt: '2026-08-10T09:00:00.000Z',
    }),
  );
  db.prepare(UPSERT_PROGRESS_SQL).run(
    ...progressRowValues(runId, {
      stage: 'source',
      stageIndex: 3,
      stageTotal: 10,
      stageStartedAt: '2026-08-10T09:01:00.000Z',
    }),
  );

  const rows = db
    .prepare('SELECT * FROM run_progress WHERE run_id = ?')
    .all(runId) as unknown[];
  assert.equal(rows.length, 1);

  const row = rows[0] as {
    stage: string;
    stage_index: number;
    stage_total: number;
    stage_started_at: string;
  };
  assert.equal(row.stage, 'source');
  assert.equal(row.stage_index, 3);
  assert.equal(row.stage_total, 10);
  assert.equal(row.stage_started_at, '2026-08-10T09:01:00.000Z');

  db.close();
});

test('progressRowValues leaves item_current/item_total NULL and fills updated_at', () => {
  const { db, runId } = dbWithRun();

  db.prepare(UPSERT_PROGRESS_SQL).run(
    ...progressRowValues(runId, {
      stage: 'structure',
      stageIndex: 5,
      stageTotal: 10,
      stageStartedAt: '2026-08-10T09:05:00.000Z',
    }),
  );

  const row = db
    .prepare('SELECT * FROM run_progress WHERE run_id = ?')
    .get(runId) as {
    updated_at: string;
    item_current: number | null;
    item_total: number | null;
  };
  assert.equal(row.item_current, null);
  assert.equal(row.item_total, null);
  assert.equal(typeof row.updated_at, 'string');
  assert.ok(row.updated_at.length > 0);

  db.close();
});

test('mapProgressRow(null) maps to null', () => {
  assert.equal(mapProgressRow(null), null);
});

test('mapProgressRow(undefined) maps to null', () => {
  assert.equal(mapProgressRow(undefined), null);
});

test('mapProgressRow maps a no-join-row shape (all-null joined columns) to null', () => {
  assert.equal(
    mapProgressRow({
      stage: null,
      stage_index: null,
      stage_total: null,
      stage_started_at: null,
      updated_at: null,
      item_current: null,
      item_total: null,
    }),
    null,
  );
});

test('mapProgressRow maps a real row, including nullable item_current/item_total', () => {
  const mapped = mapProgressRow({
    stage: 'rank',
    stage_index: 9,
    stage_total: 10,
    stage_started_at: '2026-08-10T09:09:00.000Z',
    updated_at: '2026-08-10T09:09:05.000Z',
    item_current: null,
    item_total: null,
  });
  assert.deepEqual(mapped, {
    stage: 'rank',
    stageIndex: 9,
    stageTotal: 10,
    stageStartedAt: '2026-08-10T09:09:00.000Z',
    updatedAt: '2026-08-10T09:09:05.000Z',
    itemCurrent: null,
    itemTotal: null,
  });
});

test('mapProgressRow passes through non-null item_current/item_total', () => {
  const mapped = mapProgressRow({
    stage: 'structure',
    stage_index: 5,
    stage_total: 10,
    stage_started_at: '2026-08-10T09:05:00.000Z',
    updated_at: '2026-08-10T09:05:05.000Z',
    item_current: 3,
    item_total: 12,
  });
  assert.equal(mapped?.itemCurrent, 3);
  assert.equal(mapped?.itemTotal, 12);
});
