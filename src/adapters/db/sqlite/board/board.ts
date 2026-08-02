/**
 * SqliteBoardStore — the board app's read-jobs/write-tracking surface over
 * jobbunny.db (local-DB spec §3, ownership zones). Reads `jobs` only,
 * writes `tracking` only, never the reverse — the pipeline-side
 * `SqliteStore` (../store/) owns `jobs` writes.
 *
 * `whereFor(query)` is the single place a `BoardQuery` becomes SQL: it is
 * shared by `listJobs`'s row query AND its `total` count query so the two
 * can never drift (a `tracking.status` filter without the LEFT JOIN in the
 * count would silently report the wrong total). Every caller-supplied
 * value is a bound `?` parameter; the only exception is the sort column,
 * which goes through a fixed whitelist map, never caller text.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { JD } from '../../../../core/jd/index.ts';
import { reviewFlags } from '../../../../core/jd/index.ts';
import type {
  BoardJobDetail,
  BoardJobRow,
  BoardQuery,
  BoardStore,
  TrackingPatch,
  TrackingRow,
} from '../../../../ports/board.ts';

const JOIN = 'jobs LEFT JOIN tracking ON tracking.job_id = jobs.id';

const SORT_WHITELIST: Record<'date_found' | 'score', string> = Object.assign(
  Object.create(null),
  { date_found: 'jobs.date_found', score: 'jobs.score' },
);

const SELECT_COLUMNS = `
  jobs.id, jobs.lane, jobs.title, jobs.company, jobs.url, jobs.seniority,
  jobs.location_city, jobs.work_type, jobs.timezone, jobs.skills,
  jobs.excitement, jobs.score, jobs.match_reasons, jobs.date_found,
  jobs.jd_json, jobs.archived,
  tracking.status AS t_status, tracking.comp_range AS t_comp_range,
  tracking.notes AS t_notes, tracking.contact AS t_contact,
  tracking.date_applied AS t_date_applied,
  tracking.next_action AS t_next_action,
  tracking.next_action_date AS t_next_action_date,
  tracking.updated_at AS t_updated_at
`;

const UPSERT_TRACKING_SQL = `
INSERT INTO tracking (
  job_id, status, comp_range, notes, contact,
  date_applied, next_action, next_action_date, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(job_id) DO UPDATE SET
  status = excluded.status, comp_range = excluded.comp_range,
  notes = excluded.notes, contact = excluded.contact,
  date_applied = excluded.date_applied, next_action = excluded.next_action,
  next_action_date = excluded.next_action_date, updated_at = excluded.updated_at
`;

const FIELDS = [
  'status',
  'compRange',
  'notes',
  'contact',
  'dateApplied',
  'nextAction',
  'nextActionDate',
] as const;
type FieldKey = (typeof FIELDS)[number];
type FieldMap = Record<FieldKey, string | null>;

interface RawRow {
  id: string;
  lane: string;
  title: string;
  company: string;
  url: string;
  seniority: string | null;
  location_city: string | null;
  work_type: string | null;
  timezone: string | null;
  skills: string | null;
  excitement: string | null;
  score: number | null;
  match_reasons: string | null;
  date_found: string;
  jd_json: string;
  archived: number;
  t_status: string | null;
  t_comp_range: string | null;
  t_notes: string | null;
  t_contact: string | null;
  t_date_applied: string | null;
  t_next_action: string | null;
  t_next_action_date: string | null;
  t_updated_at: string | null;
}

interface RawTrackingRow {
  job_id: string;
  status: string | null;
  comp_range: string | null;
  notes: string | null;
  contact: string | null;
  date_applied: string | null;
  next_action: string | null;
  next_action_date: string | null;
  updated_at: string;
}

/** Escapes the LIKE metacharacters in caller input so a substring search
 * for e.g. '100%' matches only companies containing that literal text,
 * never a wildcard match on unrelated names. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function toTrackingRow(jobId: string, updatedAt: string, merged: FieldMap): TrackingRow {
  const row: TrackingRow = { jobId, updatedAt };
  for (const key of FIELDS) {
    const value = merged[key];
    if (value !== null) {
      (row as unknown as Record<string, string>)[key] = value;
    }
  }
  return row;
}

function trackingFromRow(row: RawRow): TrackingRow | null {
  if (row.t_updated_at === null) return null;
  const merged: FieldMap = {
    status: row.t_status,
    compRange: row.t_comp_range,
    notes: row.t_notes,
    contact: row.t_contact,
    dateApplied: row.t_date_applied,
    nextAction: row.t_next_action,
    nextActionDate: row.t_next_action_date,
  };
  return toTrackingRow(row.id, row.t_updated_at, merged);
}

function mapRow(row: RawRow): { boardRow: BoardJobRow; jd: JD } {
  const jd = JSON.parse(row.jd_json) as JD;
  const boardRow: BoardJobRow = {
    id: row.id,
    lane: row.lane,
    title: row.title,
    company: row.company,
    url: row.url,
    seniority: row.seniority,
    locationCity: row.location_city,
    workType: row.work_type,
    timezone: row.timezone,
    skills: JSON.parse(row.skills ?? '[]') as string[],
    excitement: row.excitement,
    score: row.score,
    matchReasons: JSON.parse(row.match_reasons ?? '[]') as string[],
    reviewFlags: reviewFlags(jd.evaluation),
    dateFound: row.date_found,
    archived: row.archived === 1,
    tracking: trackingFromRow(row),
  };
  return { boardRow, jd };
}

function trackingRowToFieldMap(row: RawTrackingRow | undefined): FieldMap {
  return {
    status: row?.status ?? null,
    compRange: row?.comp_range ?? null,
    notes: row?.notes ?? null,
    contact: row?.contact ?? null,
    dateApplied: row?.date_applied ?? null,
    nextAction: row?.next_action ?? null,
    nextActionDate: row?.next_action_date ?? null,
  };
}

function mergeFields(patch: TrackingPatch, existing: FieldMap): FieldMap {
  const merged = {} as FieldMap;
  for (const key of FIELDS) {
    // Present-and-null clears, present-and-value sets, undefined/absent
    // keeps the existing value (port contract, ports/board.ts:30) — an
    // explicitly-undefined patch value must behave the same as an absent
    // key, never as a clear.
    merged[key] = patch[key] !== undefined ? (patch[key] ?? null) : existing[key];
  }
  return merged;
}

export class SqliteBoardStore implements BoardStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private whereFor(query: BoardQuery): {
    from: string;
    where: string;
    params: SQLInputValue[];
  } {
    const clauses: string[] = ['jobs.archived = ?'];
    const params: SQLInputValue[] = [query.archived ? 1 : 0];
    if (query.status !== undefined) {
      clauses.push('tracking.status = ?');
      params.push(query.status);
    }
    if (query.excitement !== undefined) {
      clauses.push('jobs.excitement = ?');
      params.push(query.excitement);
    }
    if (query.company !== undefined) {
      clauses.push("jobs.company LIKE ? ESCAPE '\\' COLLATE NOCASE");
      params.push(`%${escapeLike(query.company)}%`);
    }
    if (query.dateFrom !== undefined) {
      clauses.push('substr(jobs.date_found, 1, 10) >= ?');
      params.push(query.dateFrom);
    }
    if (query.dateTo !== undefined) {
      clauses.push('substr(jobs.date_found, 1, 10) <= ?');
      params.push(query.dateTo);
    }
    return { from: JOIN, where: `WHERE ${clauses.join(' AND ')}`, params };
  }

  listJobs(query: BoardQuery): { rows: BoardJobRow[]; total: number } {
    const { from, where, params } = this.whereFor(query);
    const sortCol =
      SORT_WHITELIST[query.sort ?? 'date_found'] ?? SORT_WHITELIST.date_found;
    const order = query.order === 'asc' ? 'ASC' : 'DESC';
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const sql = `SELECT ${SELECT_COLUMNS} FROM ${from} ${where} ORDER BY ${sortCol} ${order}, jobs.id ASC LIMIT ? OFFSET ?`;
    const rawRows = this.db
      .prepare(sql)
      .all(...params, limit, offset) as unknown as RawRow[];
    const rows = rawRows.map((r) => mapRow({ ...r }).boardRow);

    const totalRow = {
      ...(this.db
        .prepare(`SELECT COUNT(*) AS n FROM ${from} ${where}`)
        .get(...params) as { n: number }),
    };
    return { rows, total: totalRow.n };
  }

  getJob(id: string): BoardJobDetail | null {
    const sql = `SELECT ${SELECT_COLUMNS} FROM ${JOIN} WHERE jobs.id = ?`;
    const raw = this.db.prepare(sql).get(id) as RawRow | undefined;
    if (!raw) return null;
    const { boardRow, jd } = mapRow({ ...raw });
    return { ...boardRow, jd };
  }

  updateTracking(id: string, patch: TrackingPatch, now: string): TrackingRow | null {
    const exists = this.db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(id);
    if (exists === undefined) return null;

    const existingRaw = this.db
      .prepare('SELECT * FROM tracking WHERE job_id = ?')
      .get(id) as RawTrackingRow | undefined;
    const existing = existingRaw ? { ...existingRaw } : undefined;
    const merged = mergeFields(patch, trackingRowToFieldMap(existing));

    this.db.exec('SAVEPOINT jb_board_track');
    try {
      this.db
        .prepare(UPSERT_TRACKING_SQL)
        .run(
          id,
          merged.status,
          merged.compRange,
          merged.notes,
          merged.contact,
          merged.dateApplied,
          merged.nextAction,
          merged.nextActionDate,
          now,
        );
      this.db.exec('RELEASE jb_board_track');
    } catch (err) {
      this.db.exec('ROLLBACK TO jb_board_track');
      this.db.exec('RELEASE jb_board_track');
      throw err;
    }

    return toTrackingRow(id, now, merged);
  }

  close(): void {
    this.db.close();
  }
}
