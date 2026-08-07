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
 *
 * `liftMode` (Task 4 Part A) — `'readwrite'` (default) is byte-identical to
 * the behavior above. `'readonly'` is for doctor-adjacent consumers (doctor,
 * board, daemon, scan) that must NEVER create or migrate `jobbunny.db` as a
 * side effect of reading config:
 *   - No db file at all → skip `openJobsDb`/`DatabaseSync` entirely; read
 *     the legacy file directly (same loose validation), never insert.
 *   - db file exists → open it via `new DatabaseSync(this.dbPath, {
 *     readOnly: true })` directly, bypassing `openJobsDb`'s migration path
 *     entirely — mirrors `adapters/db/sqlite/check.ts`'s `sqliteDbCheck`
 *     precedent exactly, for the identical reason (see that file's own doc
 *     comment: "doctor must never create or migrate the file"). A `SELECT`
 *     against a real, valid, pre-`config_docs` database (schema v4 or
 *     earlier) throws `no such table: config_docs` — that ONE specific
 *     error is caught and treated as a miss (fall back to the legacy file,
 *     no insert); any OTHER error (corrupt file, permission denied, a
 *     schema newer than this build) propagates loud, unchanged from
 *     readwrite's posture. `writeText` throws synchronously, before
 *     touching anything — every readonly-mode consumer is read-only by
 *     construction.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateConfigDoc } from '../../../../core/config/index.ts';
import type { ConfigDocKey, ConfigStore } from '../../../../ports/config_store.ts';
import { openJobsDb } from '../store/index.ts';

interface ConfigDocRow {
  value_text: string;
}

const NO_CONFIG_DOCS_TABLE = /no such table:\s*config_docs/i;

export interface SqliteConfigStoreDeps {
  now?: () => Date;
  liftMode?: 'readwrite' | 'readonly';
}

export class SqliteConfigStore implements ConfigStore {
  private readonly dbPath: string;
  private readonly profileRoot: string;
  private readonly nowFn: () => Date;
  private readonly liftMode: 'readwrite' | 'readonly';
  private db: DatabaseSync | undefined;

  constructor(dbPath: string, profileRoot: string, deps: SqliteConfigStoreDeps = {}) {
    this.dbPath = dbPath;
    this.profileRoot = profileRoot;
    this.nowFn = deps.now ?? (() => new Date());
    this.liftMode = deps.liftMode ?? 'readwrite';
  }

  async readText(key: ConfigDocKey): Promise<string | undefined> {
    if (this.liftMode === 'readonly') return this.readTextReadonly(key);

    const db = this.open();
    const row = this.selectRow(db, key);
    if (row) return row.value_text;

    const lifted = this.readLegacyFile(key);
    if (lifted === undefined) return undefined;

    db.prepare(
      'INSERT OR REPLACE INTO config_docs (key, value_text, updated_at) VALUES (?, ?, ?)',
    ).run(key, lifted, this.nowFn().toISOString());

    return lifted;
  }

  private async readTextReadonly(key: ConfigDocKey): Promise<string | undefined> {
    if (!existsSync(this.dbPath)) return this.readLegacyFile(key);

    const db = this.openReadonly();
    let row: ConfigDocRow | undefined;
    try {
      row = this.selectRow(db, key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (NO_CONFIG_DOCS_TABLE.test(message)) return this.readLegacyFile(key);
      throw err;
    }
    if (row) return row.value_text;
    return this.readLegacyFile(key);
  }

  async writeText(key: ConfigDocKey, rawText: string): Promise<void> {
    if (this.liftMode === 'readonly') {
      throw new Error(
        `SqliteConfigStore: writeText is unsupported in readonly lift mode (key: ${key})`,
      );
    }
    // Passing the profile name closes the write-boundary gap (fix round):
    // `validateConfigDoc` also rejects a retired `settings.sqlite.path`
    // for `profile.json` when a profile name is supplied — this is the
    // ONE production `writeText` call site, so it always is.
    validateConfigDoc(key, rawText, path.basename(this.profileRoot));
    const db = this.open();
    db.prepare(
      'INSERT OR REPLACE INTO config_docs (key, value_text, updated_at) VALUES (?, ?, ?)',
    ).run(key, rawText, this.nowFn().toISOString());
    // No try/catch here — let it throw straight through (loud).
  }

  close(): void {
    this.db?.close();
  }

  private open(): DatabaseSync {
    if (!this.db) this.db = openJobsDb(this.dbPath);
    return this.db;
  }

  /** Bypasses `openJobsDb` entirely — a plain `new DatabaseSync` open on a
   * non-existent path would auto-create+migrate the file, which readonly
   * mode must never do; callers only reach this once `existsSync` has
   * already confirmed the file is there. */
  private openReadonly(): DatabaseSync {
    if (!this.db) this.db = new DatabaseSync(this.dbPath, { readOnly: true });
    return this.db;
  }

  private selectRow(db: DatabaseSync, key: ConfigDocKey): ConfigDocRow | undefined {
    return db.prepare('SELECT value_text FROM config_docs WHERE key = ?').get(key) as
      | ConfigDocRow
      | undefined;
  }

  /** Reads the legacy file for `key`, loosely validates it, and returns its
   * raw text — `undefined` on ENOENT. Never inserts; that's the readwrite
   * caller's own job. */
  private readLegacyFile(key: ConfigDocKey): string | undefined {
    const filePath = path.join(this.profileRoot, key);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    this.checkLiftable(key, filePath, raw);
    return raw;
  }

  /** Loose, key-specific lift-time check — see class doc comment (3). */
  private checkLiftable(key: ConfigDocKey, filePath: string, raw: string): void {
    if (key === 'search_urls.md') {
      if (raw.trim().length === 0) {
        throw malformedLegacyConfigFileError(
          `Malformed legacy config file at ${filePath}: file is empty`,
        );
      }
      return;
    }
    try {
      JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw malformedLegacyConfigFileError(
        `Malformed legacy config file at ${filePath}: ${message}`,
      );
    }
  }
}

/** Builds the ONE throw shape `checkLiftable` uses for an unreadable legacy
 * config file, with `name` set to a fixed contract string (fix round 2) —
 * so callers (e.g. `cli/commands/profile.ts`'s `isMalformedLegacyFileError`)
 * can detect it by `err.name` rather than string-matching the message
 * (message text is free to change; `name` is the pinned contract). */
function malformedLegacyConfigFileError(message: string): Error {
  const err = new Error(message);
  err.name = 'MalformedLegacyConfigFileError';
  return err;
}
