/**
 * cli/wire/builders.ts (P8, split from wire.ts) — live adapter construction
 * for connectors/notifiers/routines/lanes: `buildConnector`, `buildNotifier`,
 * `buildRoutine`, `isFarmingLane`, `isApiLane`, `buildLanes`,
 * `buildLinkedInLane`, `missingTokenNotionClient`, and the `MigrateWire`/
 * `wireMigrate` composition seam for `jobbunny migrate`. Sibling to
 * `compose.ts` in the `only-wire-imports-adapters` carve-out
 * (`.dependency-cruiser.cjs`) — split out purely to keep `compose.ts` under
 * the 400-line file-size cap, not for any behavioral reason.
 */
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import type { CdpChromeProvider } from '../../adapters/browser/cdp-chrome/index.ts';
import { DEFAULT_USER_DATA_DIR } from '../../adapters/browser/cdp-chrome/index.ts';
import type { NotionSdkClientLike } from '../../adapters/db/notion/index.ts';
import {
  exportForMigration,
  NotionApi,
  NotionConnector,
} from '../../adapters/db/notion/index.ts';
import {
  openJobsDb,
  SqliteConnector,
  SqliteConnectorSettingsSchema,
  SqliteStore,
} from '../../adapters/db/sqlite/index.ts';
import { GreenhouseLane } from '../../adapters/lanes/greenhouse/index.ts';
import { KekaLane } from '../../adapters/lanes/keka/index.ts';
import {
  defaultLinkedinBreakerDeps,
  LinkedInLane,
  loadInventory,
  parseSearchUrls,
} from '../../adapters/lanes/linkedin/index.ts';
import { TelegramNotifier } from '../../adapters/notify/telegram/index.ts';
import type { PipelineConfig } from '../../core/config/schema.ts';
import type { FilterConfig } from '../../core/filter/config.ts';
import type { MigratedRecord, TrackingFields } from '../../core/tracking/index.ts';
import type { RunContext } from '../../ports/context.ts';
import type { ApiLane, FarmingLane, Lane } from '../../ports/lane.ts';
import type { Storage } from '../../ports/storage.ts';
import { cleanupRoutine } from '../../routines/cleanup/index.ts';
import type { Routine } from '../../routines/types.ts';
import { isNotFound, loadPipelineConfig } from './config.ts';
import {
  resolveInterUrlDelayRange,
  resolveJitterRange,
  resolveMaxCardsPerUrl,
} from './settings.ts';

// --- live adapter construction (ctx/ports/stages/routines) ---

export function buildConnector(
  name: string,
  settings: unknown,
  api: NotionApi,
  defaultSqlitePath: string,
) {
  if (name === 'notion') return new NotionConnector(settings, api);
  if (name === 'sqlite') return new SqliteConnector(settings, defaultSqlitePath);
  throw new Error(`unknown connector "${name}"`);
}

export function buildNotifier(name: string, settings: unknown) {
  if (name === 'telegram') return new TelegramNotifier(settings);
  throw new Error(`unknown notifier "${name}"`);
}

export function buildRoutine(name: string): Routine {
  if (name === 'cleanup') return cleanupRoutine;
  throw new Error(`unknown routine "${name}"`);
}

export function isFarmingLane(lane: Lane): lane is FarmingLane {
  return lane.kind === 'farming';
}

export function isApiLane(lane: Lane): lane is ApiLane {
  return lane.kind === 'api';
}

export interface LiveLaneDeps {
  profileName: string;
  root: string;
  readFile: (path: string) => Promise<string>;
  /** Repo-root — inventories only (see `RuntimeDeps.storage`). */
  storage: Storage;
  /** `profiles/<name>/data` — the lane's own resume/capture state. */
  profileStorage: Storage;
  filterCfg: FilterConfig | undefined;
  browser: CdpChromeProvider;
}

/** Builds the live `Lane[]` for `config.lanes`. Unlike the check-registry
 * (which merely reports whether inventories/CDP are reachable), building
 * the `linkedin` lane for real needs its `SearchUrlGroup[]` and
 * `Inventory[]` up front — both are read here, fail-loud, rather than
 * deferred into the lane's own `source()` call. */
export async function buildLanes(
  config: PipelineConfig,
  deps: LiveLaneDeps,
): Promise<Lane[]> {
  const lanes: Lane[] = [];
  for (const name of config.lanes) {
    switch (name) {
      case 'linkedin':
        lanes.push(
          await buildLinkedInLane(
            deps,
            resolveMaxCardsPerUrl(config.settings.linkedin),
            resolveJitterRange(config.settings.linkedin),
            resolveInterUrlDelayRange(config.settings.linkedin),
          ),
        );
        break;
      case 'greenhouse':
        lanes.push(new GreenhouseLane());
        break;
      case 'keka':
        lanes.push(new KekaLane());
        break;
      default:
        throw new Error(`unknown lane "${name}"`);
    }
  }
  return lanes;
}

async function buildLinkedInLane(
  deps: LiveLaneDeps,
  maxCardsPerUrl: number,
  jitterRange: { minMs: number; maxMs: number },
  interUrlDelayRange: { minMs: number; maxMs: number },
): Promise<LinkedInLane> {
  if (!deps.filterCfg) {
    throw new Error(
      `linkedin lane requires profiles/${deps.profileName}/filter.json (a FilterConfig)`,
    );
  }
  const searchUrlsPath = path.join(
    deps.root,
    'profiles',
    deps.profileName,
    'search_urls.md',
  );
  let md: string;
  try {
    md = await deps.readFile(searchUrlsPath);
  } catch (err) {
    if (isNotFound(err)) {
      throw new Error(
        `linkedin lane requires profiles/${deps.profileName}/search_urls.md`,
      );
    }
    throw err;
  }
  const urls = parseSearchUrls(md);
  const pages = [...new Set(urls.map((group) => group.page))];
  const inventories = await Promise.all(
    pages.map((page) => loadInventory(deps.storage, page)),
  );
  // Inventories come off the shared repo-root handle above; the lane's own
  // resume/capture state is per-profile and must NOT.
  return new LinkedInLane(
    deps.browser,
    inventories,
    urls,
    deps.filterCfg,
    deps.profileStorage,
    maxCardsPerUrl,
    jitterRange.minMs,
    jitterRange.maxMs,
    undefined, // randomFn: real Math.random
    undefined, // sleepFn: real abort-aware core/async sleep
    interUrlDelayRange.minMs,
    interUrlDelayRange.maxMs,
    // Session-scoped, shared by every profile (D11): the throttle belongs
    // to the `.chrome-debug` Chrome profile whose cookies every profile
    // farms through, not to any one profile's data dir. Passed as a plain
    // string because `adapters-no-cross-family` forbids the lane importing
    // `adapters/browser/**` itself.
    { userDataDir: DEFAULT_USER_DATA_DIR, deps: defaultLinkedinBreakerDeps() },
  );
}

// --- missing-token Notion stub (shared by `wire()` and `wireMigrate()`) ---

/** A `NotionSdkClientLike` every method of which throws the same
 * config-problem message. Used to build a `NotionApi` (not merely a
 * `NotionApiLike`) when `NOTION_TOKEN` is missing, so `wire()` itself never
 * throws (doctor must survive a missing token — `coreChecks` already
 * reports it as a red) while the live connector still fails LOUD at first
 * actual use (`rebuildCache`/`syncJobs`/`archiveStale`), never silently. */
export function missingTokenNotionClient(): NotionSdkClientLike {
  const fail = (): never => {
    throw new Error('NOTION_TOKEN missing — set it in .env');
  };
  return {
    databases: { query: fail },
    pages: { create: fail, update: fail },
  };
}

// --- wireMigrate() (local-DB spec, PR 2 Task 4) ---
//
// Narrow composition seam for `jobbunny migrate` (Task 5): a Notion-read
// handle plus a lazily-opened sqlite import handle, nothing else — no
// pipeline, no connector, no full `wire()`. `overrides`'s type is written
// inline (not imported from `./compose.ts`) to avoid a builders<->compose
// type cycle.

export interface MigrateWire {
  /** '' when the profile has no settings.notion.dbId — command errors early. */
  dbId: string;
  /** profiles/<name>/profile.json, absolute. */
  profileJsonPath: string;
  /** Resolved jobbunny.db path — printed in the summary; opening is deferred. */
  dbPath: string;
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
  overrides: { root?: string; readFile?: (p: string) => Promise<string> } = {},
): Promise<MigrateWire> {
  const root = overrides.root ?? process.cwd();
  const readFile = overrides.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));

  const config = await loadPipelineConfig(profileName, { root, readFile });

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
  const dbPath =
    SqliteConnectorSettingsSchema.parse(config.settings.sqlite ?? {}).path ??
    path.join(root, 'profiles', profileName, 'data', 'jobbunny.db');

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
