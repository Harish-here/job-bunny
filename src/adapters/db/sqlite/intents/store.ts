/**
 * SqliteRunIntentStore — the `RunIntentStore` port over jobbunny.db's
 * `run_intents` table (UI phase 1). Lazy-open, mirroring
 * `SqliteCheckpointStore`/`SqliteStateStore` (no file I/O until the first
 * method call), and equally LOUD: no `degraded` flag, no `warnOnce`, no
 * try/catch-and-swallow anywhere except the `request` savepoint's
 * rollback-then-rethrow. An intent is a user's explicit "Run now" click —
 * silently swallowing a failure would show a queued run that no daemon
 * will ever see.
 *
 * `request`'s dedup guarantee is enforced by the database
 * (`idx_run_intents_one_pending`, a partial unique index on
 * `status = 'pending'`), not by this code checking-then-inserting — see
 * `ports/run_intents.ts` and the migration in `../store/migrations.ts`
 * for the rationale. `expired` is derived on every read via
 * `deriveIntentStatus`, never written to a row.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  type CancelIntentResult,
  INTENT_EXPIRY_MS,
  type RunIntent,
  type RunIntentStatus,
  type RunIntentStore,
} from '../../../../ports/run_intents.ts';
import { openJobsDb } from '../store/index.ts';

interface IntentRow {
  id: number;
  requested_at: string;
  status: string;
  claimed_run_id: number | null;
}

/** Pure status derivation shared by every read path on this store.
 * `stored` passes through unchanged for anything but `'pending'`; a
 * `'pending'` row older than `INTENT_EXPIRY_MS` reads as `'expired'`. A
 * `requestedAt` that fails to parse fails OPEN to `'pending'` — an
 * unreadable timestamp is not evidence of staleness. */
export function deriveIntentStatus(
  stored: string,
  requestedAt: string,
  now: string,
): RunIntentStatus {
  if (stored !== 'pending') return stored as RunIntentStatus;
  const requestedMs = Date.parse(requestedAt);
  if (Number.isNaN(requestedMs)) return 'pending';
  return Date.parse(now) - requestedMs > INTENT_EXPIRY_MS ? 'expired' : 'pending';
}

function toIntent(row: IntentRow, now: string): RunIntent {
  return {
    id: row.id,
    requestedAt: row.requested_at,
    status: deriveIntentStatus(row.status, row.requested_at, now),
    claimedRunId: row.claimed_run_id,
  };
}

export class SqliteRunIntentStore implements RunIntentStore {
  private readonly dbPath: string;
  private db: DatabaseSync | undefined;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private open(): DatabaseSync {
    if (!this.db) this.db = openJobsDb(this.dbPath);
    return this.db;
  }

  request(now: string): { intent: RunIntent; deduped: boolean } {
    const db = this.open();
    db.exec('SAVEPOINT jb_intent_request');
    try {
      const row = db
        .prepare(
          `SELECT id, requested_at, status, claimed_run_id FROM run_intents
           WHERE status = 'pending' LIMIT 1`,
        )
        .get() as IntentRow | undefined;
      if (row) {
        const derived = deriveIntentStatus(row.status, row.requested_at, now);
        if (derived === 'pending') {
          db.exec('RELEASE jb_intent_request');
          return { intent: toIntent(row, now), deduped: true };
        }
        db.prepare("UPDATE run_intents SET status = 'cancelled' WHERE id = ?").run(
          row.id,
        );
      }
      const result = db
        .prepare(
          `INSERT INTO run_intents (requested_at, status, claimed_run_id)
           VALUES (?, 'pending', NULL)`,
        )
        .run(now);
      const intent: RunIntent = {
        id: Number(result.lastInsertRowid),
        requestedAt: now,
        status: 'pending',
        claimedRunId: null,
      };
      db.exec('RELEASE jb_intent_request');
      return { intent, deduped: false };
    } catch (err) {
      db.exec('ROLLBACK TO jb_intent_request');
      db.exec('RELEASE jb_intent_request');
      throw err;
    }
  }

  cancel(id: number, now: string): CancelIntentResult {
    const db = this.open();
    const row = db
      .prepare(
        'SELECT id, requested_at, status, claimed_run_id FROM run_intents WHERE id = ?',
      )
      .get(id) as IntentRow | undefined;
    if (!row) return { outcome: 'not_found' };
    if (row.status !== 'pending') return { outcome: 'not_pending' };
    db.prepare(
      "UPDATE run_intents SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
    ).run(id);
    return {
      outcome: 'cancelled',
      intent: toIntent({ ...row, status: 'cancelled' }, now),
    };
  }

  latest(now: string): RunIntent | null {
    const db = this.open();
    const row = db
      .prepare(
        'SELECT id, requested_at, status, claimed_run_id FROM run_intents ORDER BY id DESC LIMIT 1',
      )
      .get() as IntentRow | undefined;
    return row ? toIntent(row, now) : null;
  }

  list(now: string, limit: number): RunIntent[] {
    const db = this.open();
    const rows = db
      .prepare(
        'SELECT id, requested_at, status, claimed_run_id FROM run_intents ORDER BY id DESC LIMIT ?',
      )
      .all(limit) as unknown as IntentRow[];
    return rows.map((row) => toIntent(row, now));
  }

  listClaimable(now: string): RunIntent[] {
    const db = this.open();
    const rows = db
      .prepare(
        `SELECT id, requested_at, status, claimed_run_id FROM run_intents
         WHERE status = 'pending' ORDER BY id ASC`,
      )
      .all() as unknown as IntentRow[];
    return rows
      .map((row) => toIntent(row, now))
      .filter((intent) => intent.status !== 'expired');
  }

  claim(id: number): boolean {
    const db = this.open();
    const result = db
      .prepare(
        "UPDATE run_intents SET status = 'claimed' WHERE id = ? AND status = 'pending'",
      )
      .run(id);
    return Number(result.changes) === 1;
  }

  attachRun(id: number, runId: number): void {
    const db = this.open();
    db.prepare(
      "UPDATE run_intents SET claimed_run_id = ? WHERE id = ? AND status = 'claimed'",
    ).run(runId, id);
  }

  close(): void {
    this.db?.close();
  }
}
