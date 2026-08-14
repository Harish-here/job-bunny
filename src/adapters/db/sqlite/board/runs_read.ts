/**
 * Read-only `runs`/`run_events` query logic for `SqliteBoardStore`
 * (`board.ts`) — split out purely to keep `board.ts` under the file-size
 * cap once the `run_progress` join (fix-round finding #5) and the batched
 * health-counts query (finding #4) landed; mirrors why `runs/progress.ts`
 * was split out of `runs/store.ts`. Free functions taking `db` (not a
 * class) — `board.ts`'s `SqliteBoardStore` methods are thin delegators to
 * these, so the class itself carries no runs-specific SQL text at all.
 *
 * `fetchRunHealth`'s three LIKE patterns are the read-side twin of
 * `app/features/runs/soft_errors.ts`'s own breaker-message constants —
 * duplicated, not imported: `adapters` may not import `app`
 * (`adapters-only-ports-core`) and `app` may not import `adapters`
 * (`app-only-ports-core`). `ui/src/features/runs/runOutcome.ts`'s own doc
 * comment already accepts the identical cross-layer duplication for the
 * same reason.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { RunDurationEstimate, RunEventHealth } from '../../../../ports/board.ts';
import { MIN_DURATION_SAMPLE_SIZE } from '../../../../ports/board.ts';
import type {
  RunDetail,
  RunEventRow,
  RunKind,
  RunStatus,
  RunSummary,
} from '../../../../ports/run_store.ts';
import {
  decodeCatchupSlots,
  deriveStatus,
  mapProgressRow,
  PROGRESS_JOIN,
  type RawProgressRow,
} from '../runs/index.ts';

// Extends RawProgressRow (runs/progress.ts) for the LEFT JOIN run_progress
// columns — all null when the run has no progress row. Mirrors
// SqliteRunStore's own RunRow shape exactly (adapters/db/sqlite/runs).
interface RawRunRow extends RawProgressRow {
  id: number;
  run_date: string;
  time_dir: string | null;
  kind: RunKind;
  resumed_from: number | null;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  heartbeat_at: string | null;
  result_json: string | null;
  failure_json: string | null;
  sync_dryrun_json: string | null;
  catchup_slots_json: string | null;
}

interface RawRunEventRow {
  ts: string;
  level: string;
  msg: string;
  data_json: string | null;
}

function toRunSummary(row: RawRunRow): RunSummary {
  return {
    id: row.id,
    date: row.run_date,
    timeDir: row.time_dir,
    kind: row.kind,
    resumedFrom: row.resumed_from,
    status: deriveStatus(row.status, row.heartbeat_at, new Date()),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    heartbeatAt: row.heartbeat_at,
    progress: mapProgressRow(row),
    catchupSlots: decodeCatchupSlots(row.catchup_slots_json),
  };
}

export function listRunsQuery(
  db: DatabaseSync,
  query: { limit?: number; offset?: number },
): { rows: RunSummary[]; total: number } {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  const rawRows = db
    .prepare(`SELECT runs.*, ${PROGRESS_JOIN} ORDER BY runs.id DESC LIMIT ? OFFSET ?`)
    .all(limit, offset) as unknown as RawRunRow[];
  const { n: total } = db.prepare('SELECT COUNT(*) AS n FROM runs').get() as {
    n: number;
  };
  return { rows: rawRows.map((row) => toRunSummary(row)), total };
}

export function getRunQuery(db: DatabaseSync, id: number): RunDetail | null {
  const row = db.prepare(`SELECT runs.*, ${PROGRESS_JOIN} WHERE runs.id = ?`).get(id) as
    | RawRunRow
    | undefined;
  if (!row) return null;
  return {
    ...toRunSummary(row),
    result: row.result_json === null ? null : (JSON.parse(row.result_json) as unknown),
    failure: row.failure_json === null ? null : (JSON.parse(row.failure_json) as unknown),
    syncDryrun:
      row.sync_dryrun_json === null
        ? null
        : (JSON.parse(row.sync_dryrun_json) as unknown),
  };
}

export function listRunEventsQuery(
  db: DatabaseSync,
  id: number,
  query: { limit?: number; offset?: number },
): { rows: RunEventRow[]; total: number } {
  const limit = query.limit ?? 500;
  const offset = query.offset ?? 0;
  const rawRows = db
    .prepare(
      `SELECT ts, level, msg, data_json FROM run_events
       WHERE run_id = ? ORDER BY id ASC LIMIT ? OFFSET ?`,
    )
    .all(id, limit, offset) as unknown as RawRunEventRow[];
  const { n: total } = db
    .prepare('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?')
    .get(id) as { n: number };
  const rows = rawRows.map((row) => ({
    ts: row.ts,
    level: row.level,
    msg: row.msg,
    ...(row.data_json !== null
      ? { data: JSON.parse(row.data_json) as Record<string, unknown> }
      : {}),
  }));
  return { rows, total };
}

interface RawHealthRow {
  run_id: number;
  total: number;
  breaker_hit: number;
}

/** The exact substrings of the three throttle-breaker warn messages a run
 * can log (`adapters/lanes/linkedin/lane.ts`'s open-skip, `fire/loop/
 * cards.ts`'s trip, `fire/probe.ts`'s probe re-open) — see this file's own
 * header comment on why they're duplicated here rather than imported. */
const BREAKER_LIKE_CLAUSE = `(
    msg LIKE '%throttle breaker is open%' OR
    msg LIKE '%opening the breaker%' OR
    msg LIKE '%breaker re-opened%'
  )`;

/**
 * Batched warn/error totals + breaker-open flag for a set of run ids, in
 * ONE `run_id IN (...)` query — not a per-row `listRunEvents` fetch, so the
 * runs list's health gate never becomes an N+1 read (fix-round finding
 * #4). Empty `runIds` short-circuits to an empty map without querying —
 * SQLite's `IN ()` is invalid syntax, and an empty page has nothing to
 * look up anyway. Ids with zero warn/error events are simply absent from
 * the returned map; callers default to `{ total: 0, breakerOpen: false }`.
 */
export function fetchRunHealth(
  db: DatabaseSync,
  runIds: number[],
): Map<number, RunEventHealth> {
  const result = new Map<number, RunEventHealth>();
  if (runIds.length === 0) return result;

  const placeholders = runIds.map(() => '?').join(', ');
  const sql = `
    SELECT run_id,
      COUNT(*) AS total,
      MAX(CASE WHEN ${BREAKER_LIKE_CLAUSE} THEN 1 ELSE 0 END) AS breaker_hit
    FROM run_events
    WHERE run_id IN (${placeholders}) AND level IN ('warn', 'error')
    GROUP BY run_id
  `;
  const rows = db.prepare(sql).all(...runIds) as unknown as RawHealthRow[];
  for (const row of rows) {
    result.set(row.run_id, { total: row.total, breakerOpen: row.breaker_hit === 1 });
  }
  return result;
}

interface RawDurationRow {
  started_at: string;
  finished_at: string;
}

/** Blueprint step 1.18's exact query — reproduced verbatim, not
 * "simplified": the `LEFT JOIN` + `SUM(CASE WHEN ...)` shape is what makes
 * a run with zero matching `run_events` fall out as `0 <= 0` (eligible)
 * rather than `NULL <= NULL` (which SQLite evaluates as `NULL`, silently
 * excluding the row). The `already_done <= harvested` clause is the actual
 * discriminator, found by reading what the real short same-day-resume runs
 * logged — `resumed_from IS NULL` is kept as an independently-valid,
 * currently-inert guard against a different contamination source (a manual
 * `jobbunny run --resume`), not the load-bearing clause. */
const ESTIMATE_DURATION_SQL = `
WITH counts AS (
  SELECT r.id,
    SUM(CASE WHEN e.msg LIKE '%page harvested%' THEN 1 ELSE 0 END) AS harvested,
    SUM(CASE WHEN e.msg LIKE '%skipping already-done url%' THEN 1 ELSE 0 END) AS already_done
  FROM runs r
  LEFT JOIN run_events e ON e.run_id = r.id
  WHERE r.status = 'passed' AND r.kind IN ('run', 'catchup') AND r.resumed_from IS NULL
    AND r.finished_at IS NOT NULL
  GROUP BY r.id
)
SELECT r.started_at, r.finished_at
FROM runs r
JOIN counts c ON c.id = r.id
WHERE c.already_done <= c.harvested
ORDER BY r.started_at DESC
LIMIT 10
`;

/** Median duration of the up-to-10 most recent eligible successful runs
 * (blueprint step 1.18) — `null` below `MIN_DURATION_SAMPLE_SIZE`. Standard
 * median: ascending-sorted durations, average of the two middle values on
 * an even sample count. */
export function estimateRunDurationQuery(db: DatabaseSync): RunDurationEstimate | null {
  const rows = db.prepare(ESTIMATE_DURATION_SQL).all() as unknown as RawDurationRow[];
  if (rows.length < MIN_DURATION_SAMPLE_SIZE) return null;

  const durations = rows
    .map((row) => Date.parse(row.finished_at) - Date.parse(row.started_at))
    .sort((a, b) => a - b);

  const mid = Math.floor(durations.length / 2);
  const medianMs =
    durations.length % 2 === 0
      ? ((durations[mid - 1] as number) + (durations[mid] as number)) / 2
      : (durations[mid] as number);

  return { medianMs, sampleSize: durations.length };
}
