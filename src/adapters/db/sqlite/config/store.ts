/**
 * SqliteConfigStore — the `ConfigStore` port over jobbunny.db's
 * `config_docs` table (config→db Phase 4). Lazy-open and LOUD, mirroring
 * `SqliteStateStore`'s shape (no file I/O until the first method call, no
 * `degraded` flag, no try/catch-and-swallow) — with three deliberate
 * differences:
 *
 * 1. Path resolution: the four legacy files this class lifts
 *    (`profile.json`, `filter.json`, `resume.json`, `search_urls.md`) live
 *    directly under `profiles/<name>/` — the profile ROOT — not under its
 *    `data/` subfolder (unlike `SqliteStateStore`'s legacy files, which live
 *    inside `dataDir`). The constructor's second argument is therefore
 *    named `profileRoot` and taken as-is (`profiles/<name>` itself); the
 *    legacy file path for key `K` is `path.join(profileRoot, K)`.
 *
 * 2. `readText` never parses: on a DB hit it returns `value_text`
 *    unmodified — no `JSON.parse`, no schema check. That is every caller's
 *    own job (see `ports/config_store.ts`'s doc comment).
 *
 * 3. Lift-time validation is LOOSE, not `validateConfigDoc` (Task 2's
 *    strict, full-schema validator): JSON-validity only for the three JSON
 *    docs, non-empty check only for `search_urls.md`. This exists solely to
 *    catch a truly unreadable/empty legacy file before it gets cemented
 *    into `config_docs` — a legacy `profile.json` carrying v0-shaped keys,
 *    or any other schema drift, must still lift successfully. `writeText`,
 *    by contrast, DOES call the strict `validateConfigDoc` — every value
 *    this class stores going forward must satisfy the current schema, even
 *    though what it inherits from disk on a one-time lift need not.
 *
 * Legacy files are NEVER deleted or modified — nothing in this class ever
 * calls `writeFileSync`/`unlinkSync`. Raw text is stored and returned
 * byte-for-byte; never re-serialized (`JSON.stringify(JSON.parse(raw))`
 * would silently reformat whitespace/key order).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { validateConfigDoc } from '../../../../core/config/index.ts';
import type { ConfigDocKey, ConfigStore } from '../../../../ports/config_store.ts';
import { openJobsDb } from '../store/index.ts';

interface ConfigDocRow {
  value_text: string;
}

export class SqliteConfigStore implements ConfigStore {
  private readonly dbPath: string;
  private readonly profileRoot: string;
  private readonly nowFn: () => Date;
  private db: DatabaseSync | undefined;

  constructor(dbPath: string, profileRoot: string, deps: { now?: () => Date } = {}) {
    this.dbPath = dbPath;
    this.profileRoot = profileRoot;
    this.nowFn = deps.now ?? (() => new Date());
  }

  private open(): DatabaseSync {
    if (!this.db) this.db = openJobsDb(this.dbPath);
    return this.db;
  }

  async readText(key: ConfigDocKey): Promise<string | undefined> {
    const db = this.open();
    const row = db.prepare('SELECT value_text FROM config_docs WHERE key = ?').get(key) as
      | ConfigDocRow
      | undefined;
    if (row) return row.value_text;

    const filePath = path.join(this.profileRoot, key);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }

    this.checkLiftable(key, filePath, raw);

    db.prepare(
      'INSERT OR REPLACE INTO config_docs (key, value_text, updated_at) VALUES (?, ?, ?)',
    ).run(key, raw, this.nowFn().toISOString());

    return raw;
  }

  async writeText(key: ConfigDocKey, rawText: string): Promise<void> {
    validateConfigDoc(key, rawText);
    const db = this.open();
    db.prepare(
      'INSERT OR REPLACE INTO config_docs (key, value_text, updated_at) VALUES (?, ?, ?)',
    ).run(key, rawText, this.nowFn().toISOString());
    // No try/catch here — let it throw straight through (loud).
  }

  close(): void {
    this.db?.close();
  }

  /** Loose, key-specific lift-time check — see difference (3) above. */
  private checkLiftable(key: ConfigDocKey, filePath: string, raw: string): void {
    if (key === 'search_urls.md') {
      if (raw.trim().length === 0) {
        throw new Error(`Malformed legacy config file at ${filePath}: file is empty`);
      }
      return;
    }
    try {
      JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Malformed legacy config file at ${filePath}: ${message}`);
    }
  }
}
