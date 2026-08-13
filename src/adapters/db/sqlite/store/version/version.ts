import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Read-only, non-throwing PRAGMA user_version probe. Returns `undefined`
 * when the file doesn't exist, is corrupt, or otherwise fails to open —
 * NEVER throws. Shared by `adapters/db/sqlite/check.ts`'s `sqliteDbCheck`
 * (doctor) and, from step 0.3, `cli/wire/daemon.ts`'s
 * `wireDaemonSchemaGuard` — both read the same probe rather than two
 * independently-written copies that could silently drift apart. Does NOT
 * compare against LATEST_SCHEMA_VERSION — that judgment is the caller's. */
export function readSchemaVersionReadonly(dbPath: string): number | undefined {
  if (!existsSync(dbPath)) return undefined;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
