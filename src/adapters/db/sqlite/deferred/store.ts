/**
 * SqliteDeferredSlotStore — the `DeferredSlotStore` port over jobbunny.db's
 * `deferred_slots` table (pipeline-stability-hardening D3b). Mirrors
 * `SqliteRunStore`'s pattern exactly: lazy-open via `openJobsDb` (the
 * constructor performs no file I/O), fail-soft on every method (an open
 * failure or a runtime SQL error warns once and the store degrades
 * PERMANENTLY to a no-op — writers return silently, readers return empty).
 *
 * `recordIfAbsent` relies on the `(run_date, slot)` unique index (migration
 * v7->v8) via `INSERT OR IGNORE` — no read-before-write race window, and no
 * try/catch is needed around a constraint violation since SQLite silently
 * no-ops instead of throwing.
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  DeferredSlotRow,
  DeferredSlotStore,
} from '../../../../ports/deferred_slots.ts';
import { openJobsDb } from '../store/index.ts';

interface DeferredSlotStoreDeps {
  warn?: (msg: string) => void;
}

interface DeferredSlotRawRow {
  run_date: string;
  slot: string;
  reason_code: DeferredSlotRow['reasonCode'];
  reason: string;
  decided_at: string;
  notified_at: string | null;
}

function toRow(row: DeferredSlotRawRow): DeferredSlotRow {
  return {
    runDate: row.run_date,
    slot: row.slot,
    reasonCode: row.reason_code,
    reason: row.reason,
    decidedAt: row.decided_at,
    notifiedAt: row.notified_at,
  };
}

export class SqliteDeferredSlotStore implements DeferredSlotStore {
  private readonly dbPath: string;
  private readonly warnFn: (msg: string) => void;
  private db: DatabaseSync | undefined;
  private degraded = false;
  private warned = false;

  constructor(dbPath: string, deps: DeferredSlotStoreDeps = {}) {
    this.dbPath = dbPath;
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
      this.warnOnce(
        `SqliteDeferredSlotStore: failed to open ${this.dbPath}: ${String(err)}`,
      );
      return null;
    }
  }

  private warnOnce(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    this.warnFn(msg);
  }

  recordIfAbsent(
    entry: Omit<DeferredSlotRow, 'decidedAt' | 'notifiedAt'> & { decidedAt: string },
  ): void {
    const db = this.open();
    if (!db) return;
    try {
      db.prepare(
        `INSERT OR IGNORE INTO deferred_slots (run_date, slot, reason_code, reason, decided_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(entry.runDate, entry.slot, entry.reasonCode, entry.reason, entry.decidedAt);
    } catch (err) {
      this.warnOnce(`SqliteDeferredSlotStore.recordIfAbsent failed: ${String(err)}`);
    }
  }

  listForDate(runDate: string): DeferredSlotRow[] {
    const db = this.open();
    if (!db) return [];
    try {
      const rows = db
        .prepare(
          `SELECT run_date, slot, reason_code, reason, decided_at, notified_at
           FROM deferred_slots WHERE run_date = ? ORDER BY slot`,
        )
        .all(runDate) as unknown as DeferredSlotRawRow[];
      return rows.map(toRow);
    } catch (err) {
      this.warnOnce(`SqliteDeferredSlotStore.listForDate failed: ${String(err)}`);
      return [];
    }
  }

  listUnnotifiedDatesBefore(beforeDate: string): string[] {
    const db = this.open();
    if (!db) return [];
    try {
      const rows = db
        .prepare(
          `SELECT DISTINCT run_date FROM deferred_slots
           WHERE notified_at IS NULL AND run_date < ? ORDER BY run_date`,
        )
        .all(beforeDate) as unknown as Array<{ run_date: string }>;
      return rows.map((row) => row.run_date);
    } catch (err) {
      this.warnOnce(
        `SqliteDeferredSlotStore.listUnnotifiedDatesBefore failed: ${String(err)}`,
      );
      return [];
    }
  }

  markNotified(runDate: string, notifiedAt: string): void {
    const db = this.open();
    if (!db) return;
    try {
      db.prepare('UPDATE deferred_slots SET notified_at = ? WHERE run_date = ?').run(
        notifiedAt,
        runDate,
      );
    } catch (err) {
      this.warnOnce(`SqliteDeferredSlotStore.markNotified failed: ${String(err)}`);
    }
  }

  close(): void {
    this.db?.close();
  }
}
