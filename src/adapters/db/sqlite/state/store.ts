/**
 * SqliteStateStore — the `StateStore` port over jobbunny.db's `state_docs`
 * table (persist-to-db Phase 3). Lazy-open, mirroring `SqliteCheckpointStore`
 * (no file I/O until the first method call), and equally LOUD: no
 * `degraded` flag, no `warnOnce`, no try/catch-and-swallow anywhere.
 * `openJobsDb` failing, or any SQL statement throwing, propagates straight
 * out of the method call that triggered it — state is pipeline data, so
 * silently losing a write would reintroduce already-seen jobs as new.
 *
 * On a DB miss, `readDoc` performs a ONE-TIME lazy lift of the legacy file
 * at `join(dataDir, key)` (the pre-cutover `Storage.readJson` layout) into
 * `state_docs`, then returns the value from that lift. The legacy file is
 * never deleted or modified — once lifted, every subsequent read for that
 * key finds the DB row first and never looks at the file again. The lift
 * validates the parsed JSON against the caller's schema BEFORE writing it,
 * so a legacy file that no longer matches the current schema stays a
 * transient, fixable error instead of being cemented into `state_docs` by
 * the very read that rejects it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ZodType } from 'zod';
import type { StateStore } from '../../../../ports/state_store.ts';
import { openJobsDb } from '../store/index.ts';

interface StateDocRow {
  value_json: string;
}

export class SqliteStateStore implements StateStore {
  private readonly dbPath: string;
  private readonly dataDir: string;
  private readonly nowFn: () => Date;
  private db: DatabaseSync | undefined;

  constructor(dbPath: string, dataDir: string, deps: { now?: () => Date } = {}) {
    this.dbPath = dbPath;
    this.dataDir = dataDir;
    this.nowFn = deps.now ?? (() => new Date());
  }

  private open(): DatabaseSync {
    if (!this.db) this.db = openJobsDb(this.dbPath);
    return this.db;
  }

  async readDoc<T>(key: string, schema: ZodType<T>): Promise<T | undefined> {
    const db = this.open();
    const row = db.prepare('SELECT value_json FROM state_docs WHERE key = ?').get(key) as
      | StateDocRow
      | undefined;
    if (row) {
      return schema.parse(JSON.parse(row.value_json));
    }

    const filePath = path.join(this.dataDir, key);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Malformed legacy state file at ${filePath}: ${message}`);
    }

    // Validate before writing: a legacy file that no longer matches the
    // caller's schema must stay a transient, fixable error — never get
    // cemented into state_docs by the very read that rejects it.
    const value = schema.parse(parsed);

    db.prepare(
      'INSERT OR REPLACE INTO state_docs (key, value_json, updated_at) VALUES (?, ?, ?)',
    ).run(key, JSON.stringify(parsed), this.nowFn().toISOString());

    return value;
  }

  async writeDoc(key: string, value: unknown): Promise<void> {
    const db = this.open();
    db.prepare(
      'INSERT OR REPLACE INTO state_docs (key, value_json, updated_at) VALUES (?, ?, ?)',
    ).run(key, JSON.stringify(value), this.nowFn().toISOString());
    // No try/catch here — let it throw straight through (loud).
  }

  close(): void {
    this.db?.close();
  }
}
