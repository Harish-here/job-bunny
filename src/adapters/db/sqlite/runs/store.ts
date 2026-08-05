/**
 * SqliteRunStore — the `RunStore` port over jobbunny.db's `runs` +
 * `run_events` tables (runs-observability Phase 1). Lazy-open (ledger
 * L13): the constructor touches no file I/O — the DB opens via
 * `openJobsDb` on first method call, so `wire()` never creates a DB file
 * as a side effect. Every method is fail-soft: an open failure or a
 * runtime SQL error warns once (a single `warned` flag per instance) and
 * never throws. Once open fails, the store degrades PERMANENTLY to a
 * no-op — writers return silently (`startRun` returns -1), readers return
 * empty results — because observability must never red a run.
 *
 * Crash detection is derived on read, never reconciled into the row: a
 * 'running' row whose `heartbeat_at` is null or older than
 * `RUN_HEARTBEAT_STALE_MS` displays as 'crashed' in `listRuns`/`getRun`.
 * `startRun` additionally tidies PRIOR stale 'running' rows to 'crashed'
 * for real, before inserting the new row.
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  RunDetail,
  RunEventRow,
  RunFailure,
  RunKind,
  RunStatus,
  RunStore,
  RunSummary,
} from '../../../../ports/run_store.ts';
import { openJobsDb } from '../store/index.ts';

export const RUN_HEARTBEAT_STALE_MS = 10 * 60_000;

/** Pure crash-derivation shared by `SqliteRunStore` (this file) and
 * `SqliteBoardStore` (adapters/db/sqlite/board/board.ts, board reads the
 * same `runs` table read-only) — a 'running' row whose heartbeat is null
 * or older than `RUN_HEARTBEAT_STALE_MS` displays as 'crashed'; any other
 * status passes through unchanged. Re-exported by `./index.ts`. */
export function deriveStatus(
  status: RunStatus,
  heartbeatAt: string | null,
  now: Date,
): RunStatus {
  if (status !== 'running') return status;
  const cutoff = new Date(now.getTime() - RUN_HEARTBEAT_STALE_MS).toISOString();
  if (heartbeatAt === null || heartbeatAt < cutoff) return 'crashed';
  return status;
}

interface RunStoreDeps {
  now?: () => Date;
  warn?: (msg: string) => void;
}

interface RunRow {
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
}

interface RunEventRawRow {
  ts: string;
  level: string;
  msg: string;
  data_json: string | null;
}

export class SqliteRunStore implements RunStore {
  private readonly dbPath: string;
  private readonly nowFn: () => Date;
  private readonly warnFn: (msg: string) => void;
  private db: DatabaseSync | undefined;
  private degraded = false;
  private warned = false;

  constructor(dbPath: string, deps: RunStoreDeps = {}) {
    this.dbPath = dbPath;
    this.nowFn = deps.now ?? (() => new Date());
    this.warnFn = deps.warn ?? ((msg) => console.error(msg));
  }

  private open(): DatabaseSync | null {
    if (this.degraded) return null;
    if (this.db) return this.db;
    try {
      this.db = openJobsDb(this.dbPath);
      return this.db;
    } catch (err) {
      this.degraded = true;
      this.warnOnce(`SqliteRunStore: failed to open ${this.dbPath}: ${String(err)}`);
      return null;
    }
  }

  private warnOnce(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    this.warnFn(msg);
  }

  private staleCutoff(): string {
    return new Date(this.nowFn().getTime() - RUN_HEARTBEAT_STALE_MS).toISOString();
  }

  private toSummary(row: RunRow): RunSummary {
    return {
      id: row.id,
      date: row.run_date,
      timeDir: row.time_dir,
      kind: row.kind,
      resumedFrom: row.resumed_from,
      status: deriveStatus(row.status, row.heartbeat_at, this.nowFn()),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      heartbeatAt: row.heartbeat_at,
    };
  }

  startRun(meta: {
    date: string;
    timeDir?: string;
    kind: RunKind;
    resumedFrom?: number;
    startedAt: string;
  }): number {
    const db = this.open();
    if (!db) return -1;
    try {
      db.prepare(
        `UPDATE runs SET status = 'crashed'
         WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
      ).run(this.staleCutoff());
      const result = db
        .prepare(
          `INSERT INTO runs (run_date, time_dir, kind, resumed_from, status, started_at)
           VALUES (?, ?, ?, ?, 'running', ?)`,
        )
        .run(
          meta.date,
          meta.timeDir ?? null,
          meta.kind,
          meta.resumedFrom ?? null,
          meta.startedAt,
        );
      return Number(result.lastInsertRowid);
    } catch (err) {
      this.warnOnce(`SqliteRunStore.startRun failed: ${String(err)}`);
      return -1;
    }
  }

  appendEvents(runId: number, events: RunEventRow[]): void {
    if (runId === -1) return;
    const db = this.open();
    if (!db) return;
    try {
      db.exec('BEGIN');
      try {
        const stmt = db.prepare(
          'INSERT INTO run_events (run_id, ts, level, msg, data_json) VALUES (?, ?, ?, ?, ?)',
        );
        let maxTs: string | null = null;
        for (const ev of events) {
          stmt.run(
            runId,
            ev.ts,
            ev.level,
            ev.msg,
            ev.data === undefined ? null : JSON.stringify(ev.data),
          );
          if (maxTs === null || ev.ts > maxTs) maxTs = ev.ts;
        }
        if (maxTs !== null) {
          db.prepare('UPDATE runs SET heartbeat_at = ? WHERE id = ?').run(maxTs, runId);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      this.warnOnce(`SqliteRunStore.appendEvents failed: ${String(err)}`);
    }
  }

  heartbeat(runId: number, at: string): void {
    if (runId === -1) return;
    const db = this.open();
    if (!db) return;
    try {
      db.prepare('UPDATE runs SET heartbeat_at = ? WHERE id = ?').run(at, runId);
    } catch (err) {
      this.warnOnce(`SqliteRunStore.heartbeat failed: ${String(err)}`);
    }
  }

  recordFailure(runId: number, failure: RunFailure): void {
    if (runId === -1) return;
    const db = this.open();
    if (!db) return;
    try {
      db.prepare('UPDATE runs SET failure_json = ? WHERE id = ?').run(
        JSON.stringify(failure),
        runId,
      );
    } catch (err) {
      this.warnOnce(`SqliteRunStore.recordFailure failed: ${String(err)}`);
    }
  }

  recordSyncDryrun(runId: number, report: unknown): void {
    if (runId === -1) return;
    const db = this.open();
    if (!db) return;
    try {
      db.prepare('UPDATE runs SET sync_dryrun_json = ? WHERE id = ?').run(
        JSON.stringify(report),
        runId,
      );
    } catch (err) {
      this.warnOnce(`SqliteRunStore.recordSyncDryrun failed: ${String(err)}`);
    }
  }

  finishRun(
    runId: number,
    outcome: 'passed' | 'failed',
    result: unknown,
    finishedAt: string,
  ): void {
    if (runId === -1) return;
    const db = this.open();
    if (!db) return;
    try {
      db.prepare(
        'UPDATE runs SET status = ?, result_json = ?, finished_at = ? WHERE id = ?',
      ).run(outcome, JSON.stringify(result), finishedAt, runId);
    } catch (err) {
      this.warnOnce(`SqliteRunStore.finishRun failed: ${String(err)}`);
    }
  }

  listRuns(opts: { limit?: number; offset?: number } = {}): RunSummary[] {
    const db = this.open();
    if (!db) return [];
    try {
      const rows = db
        .prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ? OFFSET ?')
        .all(opts.limit ?? 50, opts.offset ?? 0) as unknown as RunRow[];
      return rows.map((row) => this.toSummary(row));
    } catch (err) {
      this.warnOnce(`SqliteRunStore.listRuns failed: ${String(err)}`);
      return [];
    }
  }

  getRun(id: number): RunDetail | null {
    const db = this.open();
    if (!db) return null;
    try {
      const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
        | RunRow
        | undefined;
      if (!row) return null;
      return {
        ...this.toSummary(row),
        result:
          row.result_json === null ? null : (JSON.parse(row.result_json) as unknown),
        failure:
          row.failure_json === null ? null : (JSON.parse(row.failure_json) as unknown),
        syncDryrun:
          row.sync_dryrun_json === null
            ? null
            : (JSON.parse(row.sync_dryrun_json) as unknown),
      };
    } catch (err) {
      this.warnOnce(`SqliteRunStore.getRun failed: ${String(err)}`);
      return null;
    }
  }

  listEvents(
    runId: number,
    opts: { limit?: number; offset?: number } = {},
  ): RunEventRow[] {
    const db = this.open();
    if (!db) return [];
    try {
      const rows = db
        .prepare(
          `SELECT ts, level, msg, data_json FROM run_events
           WHERE run_id = ? ORDER BY id ASC LIMIT ? OFFSET ?`,
        )
        .all(runId, opts.limit ?? 500, opts.offset ?? 0) as unknown as RunEventRawRow[];
      return rows.map((row) => ({
        ts: row.ts,
        level: row.level,
        msg: row.msg,
        ...(row.data_json !== null
          ? { data: JSON.parse(row.data_json) as Record<string, unknown> }
          : {}),
      }));
    } catch (err) {
      this.warnOnce(`SqliteRunStore.listEvents failed: ${String(err)}`);
      return [];
    }
  }

  findRunId(date: string, timeDir: string): number | null {
    const db = this.open();
    if (!db) return null;
    try {
      const row = db
        .prepare(
          'SELECT id FROM runs WHERE run_date = ? AND time_dir = ? ORDER BY id DESC LIMIT 1',
        )
        .get(date, timeDir) as { id: number } | undefined;
      return row ? row.id : null;
    } catch (err) {
      this.warnOnce(`SqliteRunStore.findRunId failed: ${String(err)}`);
      return null;
    }
  }

  pruneRunsOlderThan(today: string, ttlDays: number): number {
    const db = this.open();
    if (!db) return 0;
    try {
      const cutoffDate = new Date(`${today}T00:00:00.000Z`);
      cutoffDate.setUTCDate(cutoffDate.getUTCDate() - ttlDays);
      const cutoff = cutoffDate.toISOString().slice(0, 10);
      db.exec('SAVEPOINT jb_prune_runs');
      try {
        db.prepare(
          `DELETE FROM run_events WHERE run_id IN (
             SELECT id FROM runs WHERE run_date < ? AND run_date != ?
           )`,
        ).run(cutoff, today);
        const result = db
          .prepare('DELETE FROM runs WHERE run_date < ? AND run_date != ?')
          .run(cutoff, today);
        db.exec('RELEASE jb_prune_runs');
        return Number(result.changes);
      } catch (err) {
        db.exec('ROLLBACK TO jb_prune_runs');
        db.exec('RELEASE jb_prune_runs');
        throw err;
      }
    } catch (err) {
      this.warnOnce(`SqliteRunStore.pruneRunsOlderThan failed: ${String(err)}`);
      return 0;
    }
  }

  close(): void {
    this.db?.close();
  }
}
