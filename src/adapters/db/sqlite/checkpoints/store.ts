/**
 * SqliteCheckpointStore — the `CheckpointStore` port over jobbunny.db's
 * `checkpoints` table (checkpoints-to-db Phase 2). Lazy-open, mirroring
 * `SqliteRunStore`'s constructor contract (no file I/O until the first
 * method call — pinned by a `wire()` test elsewhere), but UNLIKE
 * `SqliteRunStore` this class is LOUD: no `degraded` flag, no `warnOnce`,
 * no try/catch-and-swallow anywhere. `openJobsDb` failing, or any SQL
 * statement throwing, propagates straight out of the method call that
 * triggered it — checkpoints are recovery data, so silently losing one
 * would turn a resumable failure into a from-scratch rerun.
 *
 * `write` persists `ref.writtenBy` (the writing invocation's own `runs` row
 * id) into the `written_by` column, `NULL` when absent; `readLatest` round-
 * trips it back onto the returned `ref`.
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  CheckpointRef,
  CheckpointStore,
} from '../../../../ports/checkpoint_store.ts';
import { openJobsDb } from '../store/index.ts';

interface CheckpointRow {
  run_date: string;
  time_dir: string;
  position: number;
  stage: string;
  payload_json: string;
  written_by: number | null;
}

export class SqliteCheckpointStore implements CheckpointStore {
  private readonly dbPath: string;
  private readonly nowFn: () => Date;
  private db: DatabaseSync | undefined;

  constructor(dbPath: string, deps: { now?: () => Date } = {}) {
    this.dbPath = dbPath;
    this.nowFn = deps.now ?? (() => new Date());
  }

  private open(): DatabaseSync {
    if (!this.db) this.db = openJobsDb(this.dbPath);
    return this.db;
  }

  write(ref: CheckpointRef, payload: unknown): void {
    const db = this.open();
    db.prepare(
      `INSERT OR REPLACE INTO checkpoints
         (run_date, time_dir, position, stage, payload_json, written_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ref.runDate,
      ref.timeDir,
      ref.position,
      ref.stage,
      JSON.stringify(payload),
      ref.writtenBy ?? null,
      this.nowFn().toISOString(),
    );
    // No try/catch here — let it throw straight through (loud).
  }

  readLatest(
    runDate: string,
    timeDir: string,
  ): { ref: CheckpointRef; payload: unknown } | undefined {
    const db = this.open();
    const row = db
      .prepare(
        `SELECT * FROM checkpoints WHERE run_date = ? AND time_dir = ?
         ORDER BY position DESC LIMIT 1`,
      )
      .get(runDate, timeDir) as CheckpointRow | undefined;
    if (!row) return undefined;
    return {
      ref: {
        runDate: row.run_date,
        timeDir: row.time_dir,
        position: row.position,
        stage: row.stage,
        ...(row.written_by !== null ? { writtenBy: row.written_by } : {}),
      },
      payload: JSON.parse(row.payload_json) as unknown,
    };
  }

  latestTimeDir(runDate: string): string | undefined {
    const db = this.open();
    const row = db
      .prepare(
        `SELECT time_dir FROM (
           SELECT time_dir FROM checkpoints WHERE run_date = ?
           UNION
           SELECT time_dir FROM runs WHERE run_date = ? AND time_dir IS NOT NULL
         ) ORDER BY time_dir DESC LIMIT 1`,
      )
      .get(runDate, runDate) as { time_dir: string } | undefined;
    return row?.time_dir;
  }

  latestCheckpointTimeDir(runDate: string): string | undefined {
    const db = this.open();
    const row = db
      .prepare(
        'SELECT time_dir FROM checkpoints WHERE run_date = ? ORDER BY time_dir DESC LIMIT 1',
      )
      .get(runDate) as { time_dir: string } | undefined;
    return row?.time_dir;
  }

  nextTimeDir(runDate: string, time: string): string {
    const db = this.open();
    const exists = (candidate: string): boolean =>
      db
        .prepare(
          `SELECT 1 FROM (
             SELECT time_dir FROM checkpoints WHERE run_date = ?
             UNION
             SELECT time_dir FROM runs WHERE run_date = ? AND time_dir IS NOT NULL
           ) WHERE time_dir = ? LIMIT 1`,
        )
        .get(runDate, runDate, candidate) !== undefined;
    let candidate = time;
    let suffix = 2;
    while (exists(candidate)) {
      candidate = `${time}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  pruneOlderThan(todayDate: string, ttlDays: number): number {
    const db = this.open();
    const cutoffDate = new Date(`${todayDate}T00:00:00.000Z`);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - ttlDays);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    db.exec('SAVEPOINT jb_prune_checkpoints');
    try {
      const result = db
        .prepare('DELETE FROM checkpoints WHERE run_date < ? AND run_date != ?')
        .run(cutoff, todayDate);
      db.exec('RELEASE jb_prune_checkpoints');
      return Number(result.changes);
    } catch (err) {
      db.exec('ROLLBACK TO jb_prune_checkpoints');
      db.exec('RELEASE jb_prune_checkpoints');
      throw err; // LOUD — no warnOnce/no-op, unlike SqliteRunStore.pruneRunsOlderThan
    }
  }

  close(): void {
    this.db?.close();
  }
}
