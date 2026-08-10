/**
 * Row-mapping / upsert helpers for the `run_progress` table (persist-to-db
 * run experience overhaul, R3). Kept OUT of `store.ts` — pure SQL text and
 * row<->RunProgress mapping only, no DB handle owned here — specifically
 * because `store.ts` is already at the file-size cap (see its own header
 * comment); mirrors why `board_daemon.ts` was split out of `board.ts`.
 */
import type { SQLInputValue } from 'node:sqlite';
import type { RunProgress } from '../../../../ports/run_store.ts';

export interface ProgressInput {
  stage: string;
  stageIndex: number;
  stageTotal: number;
  stageStartedAt: string;
}

/** One row per run_id — insert on first write, update in place on every
 * later stage transition (`ON CONFLICT(run_id) DO UPDATE`). Covers every
 * `run_progress` column except the `run_id` key itself; `item_current`/
 * `item_total` are always written as the caller's values (NULL today, per
 * `progressRowValues`, since no writer fills them in yet — spec AC5). */
export const UPSERT_PROGRESS_SQL = `
  INSERT INTO run_progress
    (run_id, stage, stage_index, stage_total, stage_started_at, updated_at, item_current, item_total)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id) DO UPDATE SET
    stage = excluded.stage,
    stage_index = excluded.stage_index,
    stage_total = excluded.stage_total,
    stage_started_at = excluded.stage_started_at,
    updated_at = excluded.updated_at,
    item_current = excluded.item_current,
    item_total = excluded.item_total
`;

/** Positional bind values for `UPSERT_PROGRESS_SQL`. `updated_at` is filled
 * from the current time; `item_current`/`item_total` stay NULL — no writer
 * populates within-stage counters yet (nullable from day one, spec AC5).
 * Typed `SQLInputValue[]` (mirrors `SqliteStore.jobRowValues`) rather than
 * `unknown[]` so the array spreads cleanly into `StatementSync.run()`. */
export function progressRowValues(
  runId: number,
  progress: ProgressInput,
): SQLInputValue[] {
  return [
    runId,
    progress.stage,
    progress.stageIndex,
    progress.stageTotal,
    progress.stageStartedAt,
    new Date().toISOString(),
    null,
    null,
  ];
}

interface RawProgressRow {
  stage: string | null;
  stage_index: number | null;
  stage_total: number | null;
  stage_started_at: string | null;
  updated_at: string | null;
  item_current: number | null;
  item_total: number | null;
}

/** Maps a `run_progress` row (or the all-NULL shape a `LEFT JOIN` produces
 * when no row matches) to `RunProgress`. Returns null for a missing row or
 * for the no-match join shape — a finished run's stale progress row is
 * otherwise harmless to keep (see store.ts's LEFT JOIN). */
export function mapProgressRow(
  row: RawProgressRow | null | undefined,
): RunProgress | null {
  if (
    !row ||
    row.stage === null ||
    row.stage_index === null ||
    row.stage_total === null ||
    row.stage_started_at === null ||
    row.updated_at === null
  ) {
    return null;
  }
  return {
    stage: row.stage,
    stageIndex: row.stage_index,
    stageTotal: row.stage_total,
    stageStartedAt: row.stage_started_at,
    updatedAt: row.updated_at,
    itemCurrent: row.item_current,
    itemTotal: row.item_total,
  };
}
