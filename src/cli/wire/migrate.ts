/**
 * cli/wire/migrate.ts (config→db Phase 4, split out of `builders.ts` to
 * keep it under the file-size cap — sibling to `board.ts`/`daemon.ts`,
 * each of which already owns its own `wireX` composition seam split out
 * of the same `builders.ts`/`compose.ts` origin) — the `MigrateWire`/
 * `wireMigrate` seam for `jobbunny migrate` (local-DB spec PR 2 Task 4): a
 * Notion-read handle plus a lazily-opened sqlite import handle, nothing
 * else — no pipeline, no connector, no full `wire()`.
 *
 * Added to the `only-wire-imports-adapters` carve-out in
 * `.dependency-cruiser.cjs` alongside `compose.ts`/`builders.ts`/
 * `board.ts`/`daemon.ts`.
 */
import path from 'node:path';
import { exportForMigration, NotionApi } from '../../adapters/db/notion/index.ts';
import { SqliteConfigStore } from '../../adapters/db/sqlite/config/index.ts';
import { openJobsDb, SqliteStore } from '../../adapters/db/sqlite/index.ts';
import type { MigratedRecord, TrackingFields } from '../../core/tracking/index.ts';
import type { ConfigStore } from '../../ports/config_store.ts';
import type { RunContext } from '../../ports/context.ts';
import { canonicalDbPath, missingTokenNotionClient } from './builders.ts';
import { loadPipelineConfig } from './config.ts';

export interface MigrateWire {
  /** '' when the profile has no settings.notion.dbId — command errors early. */
  dbId: string;
  /** profiles/<name>/profile.json, absolute. */
  profileJsonPath: string;
  /** Resolved jobbunny.db path — printed in the summary; opening is deferred. */
  dbPath: string;
  /** Config→db Phase 4 seam for Task 7's profile.json read-modify-write —
   * NOT wired up to any write path in this task, just exposed. Readwrite
   * (migrate is a meaningful first use of the profile's config docs). */
  configStore: ConfigStore;
  exportRecords(ctx: RunContext): Promise<MigratedRecord[]>;
  /** Opens the DB on FIRST CALL — dry-run never calls it, so dry-run
   * creates no file. Insert-only on both tables. */
  importRecords(
    records: MigratedRecord[],
    now: string,
  ): { jobs: number; tracking: number };
}

export async function wireMigrate(
  profileName: string,
  overrides: { root?: string; configStore?: ConfigStore } = {},
): Promise<MigrateWire> {
  const root = overrides.root ?? process.cwd();
  const dbPath = canonicalDbPath(root, profileName);
  const profileRoot = path.join(root, 'profiles', profileName);
  const configStore =
    overrides.configStore ??
    new SqliteConfigStore(dbPath, profileRoot, { liftMode: 'readwrite' });

  const config = await loadPipelineConfig(profileName, { configStore });

  // Tolerant read, not `NotionConnectorSettingsSchema.parse`: a
  // `settings.notion` slice that exists but omits `dbId` (e.g. `{ dryRun:
  // true }`) must resolve to '' here so the command's clean "no
  // settings.notion.dbId configured" exit fires, rather than a raw zod
  // error at wire time.
  const notionSlice = config.settings.notion;
  const dbId =
    notionSlice &&
    typeof notionSlice === 'object' &&
    'dbId' in notionSlice &&
    typeof (notionSlice as { dbId: unknown }).dbId === 'string'
      ? (notionSlice as { dbId: string }).dbId
      : '';

  // Same posture as `wire()`: a real `NotionApi` when `NOTION_TOKEN` is
  // present, otherwise one built over the throwing stub, so `wireMigrate`
  // itself never throws on a missing token — the command surfaces that at
  // first actual `exportRecords` use instead.
  let api: NotionApi;
  try {
    api = new NotionApi();
  } catch {
    api = new NotionApi({ client: missingTokenNotionClient() });
  }

  const profileJsonPath = path.join(root, 'profiles', profileName, 'profile.json');

  // Lazy + memoized: opening `dbPath` (via `openJobsDb`) only happens on the
  // first `importRecords` call, so `migrate --dry-run` — which never calls
  // it — creates no database file.
  let store: SqliteStore | undefined;
  function getStore(): SqliteStore {
    if (!store) store = new SqliteStore(openJobsDb(dbPath));
    return store;
  }

  return {
    dbId,
    profileJsonPath,
    dbPath,
    configStore,
    exportRecords: (ctx) => exportForMigration(api, dbId, ctx),
    importRecords(records, now) {
      const s = getStore();
      const jobs = s.importJobs(
        records.map((r) => r.jd),
        now,
      );
      const tracking = s.importTracking(
        records
          .filter(
            (r): r is MigratedRecord & { tracking: TrackingFields } =>
              r.tracking !== undefined,
          )
          .map((r) => ({
            jobId: r.jd.identity.id,
            fields: r.tracking,
            updatedAt: now,
          })),
      );
      return { jobs, tracking };
    },
  };
}
