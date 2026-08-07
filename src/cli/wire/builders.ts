/**
 * cli/wire/builders.ts (P8, split from wire.ts) — live adapter construction
 * for connectors/notifiers/routines/lanes: `buildConnector`, `buildNotifier`,
 * `buildRoutine`, `isFarmingLane`/`isApiLane`/`buildLanes`/
 * `buildLinkedInLane`, `missingTokenNotionClient`, the opt-in sqlite→Notion
 * mirror (`mirrorDbId`/`buildMirroredConnector`/`mirrorReachableCheck`,
 * local-DB spec PR 3 — a malformed settings slice means 'no mirror', never
 * a throw; a broken mirror's doctor check warns, never reds), the
 * `canonicalDbPath`/`assertSqlitePathRetired` pair (config→db Phase 4 — the
 * authoritative resolver + its wire-time enforcement; the old, settings-
 * honoring `resolveSqlitePath` shim is retired now that Task 5 converted
 * `board.ts`/`daemon.ts` off it), and the standalone `wireConfigStore` seam.
 * `MigrateWire`/`wireMigrate` moved to its own file
 * (`./migrate.ts`, config→db Phase 4) once adding this file's other new
 * exports pushed this one over the file-size cap. Sibling to `compose.ts`
 * in the `only-wire-imports-adapters` carve-out — split out purely to keep
 * `compose.ts` under its line cap, not behavioral.
 */
import path from 'node:path';
import type { CdpChromeProvider } from '../../adapters/browser/cdp-chrome/index.ts';
import { cdpReachableCheck } from '../../adapters/browser/cdp-chrome/index.ts';
import { MirrorConnector } from '../../adapters/db/mirror/index.ts';
import type {
  DbReachableCheckDeps,
  NotionConnectorSettings,
  NotionSdkClientLike,
} from '../../adapters/db/notion/index.ts';
import {
  dbReachableCheck,
  type NotionApi,
  NotionConnector,
  NotionConnectorSettingsSchema,
} from '../../adapters/db/notion/index.ts';
import { SqliteConfigStore } from '../../adapters/db/sqlite/config/index.ts';
import { SqliteConnector, sqliteDbCheck } from '../../adapters/db/sqlite/index.ts';
import { GreenhouseLane } from '../../adapters/lanes/greenhouse/index.ts';
import { KekaLane } from '../../adapters/lanes/keka/index.ts';
import {
  defaultLinkedinBreakerDeps,
  inventoryFreshnessCheck,
  LinkedInLane,
  loadInventory,
  parseSearchUrls,
} from '../../adapters/lanes/linkedin/index.ts';
import {
  botTokenCheck,
  TelegramNotifier,
  TelegramNotifierSettingsSchema,
} from '../../adapters/notify/telegram/index.ts';
import type { PipelineConfig } from '../../core/config/schema.ts';
import { sqlitePathRetiredMessage } from '../../core/config/validators.ts';
import type { FilterConfig } from '../../core/filter/config.ts';
import type { ConfigStore } from '../../ports/config_store.ts';
import type { Connector } from '../../ports/connector.ts';
import type { DoctorCheck, DoctorFinding } from '../../ports/doctor.ts';
import type { ApiLane, FarmingLane, Lane } from '../../ports/lane.ts';
import type { StateStore } from '../../ports/state_store.ts';
import type { Storage } from '../../ports/storage.ts';
import { cleanupRoutine } from '../../routines/cleanup/index.ts';
import type { Routine } from '../../routines/types.ts';
import { resolveHome } from '../home/index.ts';
import type { AdapterRegistry } from './registry.ts';
import {
  resolveInterUrlDelayRange,
  resolveInventoryMaxAgeDays,
  resolveJitterRange,
  resolveMaxCardsPerUrl,
} from './settings.ts';

// --- live adapter construction (ctx/ports/stages/routines) ---

/** THE single authoritative jobbunny.db path — always
 * `profiles/<name>/data/jobbunny.db`. No settings-based override exists
 * (config→db Phase 4 retires `settings.sqlite.path` — see
 * `assertSqlitePathRetired`); this function takes no settings input at all.
 * `board.ts`/`daemon.ts` both resolve every profile's db path through this
 * one function now (Task 5) — the old settings-honoring `resolveSqlitePath`
 * shim they used to lean on is retired. */
export function canonicalDbPath(root: string, profileName: string): string {
  return path.join(root, 'profiles', profileName, 'data', 'jobbunny.db');
}

/** Throws when a config still sets `settings.sqlite.path` — the ONE
 * enforcement point for the retirement (spec's bootstrap decision). Checks
 * for the KEY'S PRESENCE, not its validity — a malformed value is still a
 * violation (the setting itself is dead, regardless of shape). Message is
 * BYTE-EXACT and interpolates the real profile name — pin the full string,
 * callers must not paraphrase it. */
export function assertSqlitePathRetired(
  config: PipelineConfig,
  profileName: string,
): void {
  const sqliteSlice = config.settings.sqlite;
  const hasPath =
    sqliteSlice !== null &&
    typeof sqliteSlice === 'object' &&
    'path' in (sqliteSlice as object);
  if (hasPath) {
    // Shares the exact wording with `core/config/validators.ts`'s
    // `validateConfigDoc` write-boundary check (fix round) — one canonical
    // string, not two independently-worded copies.
    throw new Error(sqlitePathRetiredMessage(profileName));
  }
}

export interface WireConfigStoreOverrides {
  root?: string;
  liftMode?: 'readwrite' | 'readonly';
}

/** Narrow composition seam (sibling to `wireBoard`/`wireMigrate`/
 * `wireDaemonRunHistory`): a standalone `ConfigStore` for ONE profile, for
 * callers that need to read/write a config doc without a full `wire()`.
 * Default `liftMode: 'readwrite'` — most callers (setup, `jobbunny config`,
 * the writers) are meaningful-first-use contexts; pass `'readonly'`
 * explicitly for a read-only caller (mirrors `wire()`'s own default). */
export function wireConfigStore(
  profileName: string,
  overrides: WireConfigStoreOverrides = {},
): ConfigStore {
  const root = overrides.root ?? resolveHome();
  const dbPath = canonicalDbPath(root, profileName);
  const profileRoot = path.join(root, 'profiles', profileName);
  return new SqliteConfigStore(dbPath, profileRoot, {
    liftMode: overrides.liftMode ?? 'readwrite',
  });
}

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

/** The mirror gate — `NotionConnectorSettingsSchema` (via `safeParse`) is
 * the SINGLE authority on whether a sqlite profile's Notion mirror applies:
 * a malformed `settings.notion` slice always means 'no mirror', never a
 * throw at wire time (I1 — mirror problems must never fail a healthy sqlite
 * run). Returns the parsed settings (never the raw slice) so callers hand
 * `NotionConnector` input its own parse can never reject.
 *
 * The `mirror === true` structural check runs BEFORE the schema parse: it's
 * a cheap short-circuit for the common case (no notion slice / not opted
 * in), and the schema's `mirror` field defaults to `false` — parsing a
 * slice that never set `mirror` would still validate, so gating on the
 * parsed value alone would silently mirror a profile that never opted in. */
function mirrorSettings(config: PipelineConfig): NotionConnectorSettings | null {
  if (config.connector !== 'sqlite') return null;
  const notionSlice = config.settings.notion;
  if (!notionSlice || typeof notionSlice !== 'object') return null;
  if ((notionSlice as { mirror?: unknown }).mirror !== true) return null;
  const parsed = NotionConnectorSettingsSchema.safeParse(notionSlice);
  return parsed.success ? parsed.data : null;
}

/** The Notion dbId a sqlite profile's mirror should push to — '' when the
 * mirror doesn't apply: connector isn't sqlite, no notion slice, mirror
 * flag absent/false, or the slice fails `NotionConnectorSettingsSchema`
 * (which also covers a missing/empty dbId, since the schema requires
 * `dbId` to be a non-empty string). See `mirrorSettings` — this is a thin
 * projection of it, kept as its own export because callers only ever want
 * the id. */
export function mirrorDbId(config: PipelineConfig): string {
  return mirrorSettings(config)?.dbId ?? '';
}

/** Wraps `connector` in a MirrorConnector pushing to Notion when the
 * profile opts in and its notion slice parses (mirrorSettings !== null);
 * returns it unchanged otherwise. The `NotionConnector` below is built from
 * the ALREADY-PARSED settings, not the raw slice — its own constructor
 * parse can therefore never throw on wire-validated input.
 * Deliberately does NOT check NOTION_TOKEN presence — a token-less mirror
 * wraps and warns once per run; the warn is the operator's reminder. */
export function buildMirroredConnector(
  connector: Connector,
  config: PipelineConfig,
  api: NotionApi,
): Connector {
  const settings = mirrorSettings(config);
  if (!settings) return connector;
  return new MirrorConnector(connector, new NotionConnector(settings, api));
}

/** mirrorReachableCheck (I2) — wraps `dbReachableCheck` for a MIRRORED
 * sqlite profile: a `red` finding (auth/permission/not-found against the
 * mirror target) is downgraded to `warn` and its detail suffixed, since a
 * broken mirror never impairs the sqlite source of truth a mirrored
 * profile actually runs on — only the mirror push itself is affected.
 * `ok`/`warn` findings from the inner check pass through unchanged. */
export function mirrorReachableCheck(deps: DbReachableCheckDeps): DoctorCheck {
  const inner = dbReachableCheck(deps);
  return {
    name: inner.name,
    async run(): Promise<DoctorFinding> {
      const finding = await inner.run();
      if (finding.status !== 'red') return finding;
      return {
        ...finding,
        status: 'warn',
        detail: `${finding.detail} — mirror only; local runs are unaffected`,
      };
    },
  };
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
  /** Config→db Phase 4: `search_urls.md` is read through the `ConfigStore`
   * seam, not a raw `readFile`/`root`. */
  configStore: ConfigStore;
  /** Repo-root — inventories only (see `RuntimeDeps.storage`). */
  storage: Storage;
  /** Phase 3: the lane's resume/capture state target. */
  stateStore: StateStore;
  filterCfg: FilterConfig | undefined;
  browser: CdpChromeProvider;
  /** The Chrome user-data-dir, `join(<data home>, 'chrome')`. The LinkedIn
   * throttle breaker's state file lives inside it; passed as a plain string
   * because `adapters-no-cross-family` forbids the lane importing
   * `adapters/browser/**`. */
  chromeUserDataDir: string;
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
  const md = await deps.configStore.readText('search_urls.md');
  if (md === undefined) {
    throw new Error(`linkedin lane requires profiles/${deps.profileName}/search_urls.md`);
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
    deps.stateStore,
    maxCardsPerUrl,
    jitterRange.minMs,
    jitterRange.maxMs,
    undefined, // randomFn: real Math.random
    undefined, // sleepFn: real abort-aware core/async sleep
    interUrlDelayRange.minMs,
    interUrlDelayRange.maxMs,
    // Session-scoped, shared by every profile (D11): the throttle belongs
    // to the shared `<data home>/chrome` Chrome profile whose cookies every
    // profile farms through, not to any one profile's data dir. Passed as a
    // plain string because `adapters-no-cross-family` forbids the lane
    // importing `adapters/browser/**` itself.
    { userDataDir: deps.chromeUserDataDir, deps: defaultLinkedinBreakerDeps() },
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

// --- real registry (moved from compose.ts to stay under its line cap —
// purely a file-size split, not behavioral: this is still the only OTHER
// place, alongside `wire()` itself, real adapters are constructed) ---

export const realRegistry: AdapterRegistry = {
  lanes: {
    // The CDP-reachability check rides with the browser-driven linkedin
    // lane rather than living on its own — nothing else in the registry
    // touches the browser.
    linkedin: (settings, deps) => [
      inventoryFreshnessCheck(
        deps.storage,
        deps.pages,
        resolveInventoryMaxAgeDays(settings),
      ),
      cdpReachableCheck({
        reachable: deps.browserReachable,
        port: deps.cdpPort,
        userDataDir: deps.chromeUserDataDir,
      }),
    ],
    // Greenhouse/Keka lanes are stateless keyless-ATS lanes with no doctor
    // surface of their own.
    greenhouse: () => [],
    keka: () => [],
  },
  connectors: {
    notion: (settings, deps) => {
      const parsed = NotionConnectorSettingsSchema.parse(settings);
      // No token ⇒ no api handle ⇒ nothing to reach-check here — the
      // missing token itself is already a red from `coreChecks`.
      if (!deps.notionApi) return [];
      return [dbReachableCheck({ api: deps.notionApi, dbId: parsed.dbId })];
    },
    // `settings.sqlite.path` is retired (config→db Phase 4) — the db path
    // is always `deps.sqliteDefaultPath`; no remaining field is relevant here.
    sqlite: (_settings, deps) => [sqliteDbCheck({ path: deps.sqliteDefaultPath })],
  },
  notifiers: {
    telegram: (settings) => {
      TelegramNotifierSettingsSchema.parse(settings);
      return [botTokenCheck()];
    },
  },
};

// `MigrateWire`/`wireMigrate` (local-DB spec, PR 2 Task 4) now live in
// `./migrate.ts` — split out to keep this file under the file-size cap
// (sibling to `board.ts`/`daemon.ts`, each already its own `wireX` seam
// split out of this same origin). `missingTokenNotionClient` above and
// `canonicalDbPath` above are its two remaining imports from this file.
