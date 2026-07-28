/**
 * cli/wire.ts (P8) — the single composition point permitted to import from
 * `src/adapters/**` (`only-wire-imports-adapters` in
 * `.dependency-cruiser.cjs`). Everything else — `pipeline/`, `routines/`,
 * `ops/`, and every other file under `src/cli` (including this file's own
 * test) — reaches adapters only through what `wire()` hands back.
 *
 * Three independent things live here:
 *  - Config loading (`loadPipelineConfig`/`loadFilterConfig`): reads
 *    `profiles/<name>/profile.json` / `filter.json`, parses, and
 *    validates against the core schemas. This is fail-loud config, NOT a
 *    doctor check — a missing/invalid `profile.json` throws immediately
 *    (mirrors `ops/doctor/aggregate.ts`'s `profileParsesCheck`, which
 *    reports the same failure as a `red` finding instead — the two are
 *    deliberately redundant: one lets `/doctor` explain *why* wiring would
 *    fail without throwing, the other actually enforces it at wire time).
 *  - Adapter-check assembly (`assembleAdapterChecks` + `AdapterRegistry`):
 *    a PURE function mapping `PipelineConfig.lanes/connector/notifiers`
 *    names onto a registry of `CheckFactory`s and concatenating the
 *    `DoctorCheck[]` each contributes. This is the part under TDD via a
 *    FAKE registry in `wire.test.ts` — it does no IO and needs no real
 *    adapter to exercise its lookup/ordering/error-naming/settings-slicing
 *    behavior.
 *  - Live composition (`wire()`'s ctx/stages/routines build below the
 *    checks): resolves `PipelineConfig.lanes/connector/notifiers/routines`
 *    against real adapter constructors (unknown name ⇒ loud throw, same
 *    posture as the check registry's `resolveFactory`) and assembles the
 *    frozen 10-stage job-flow plus a `PipelineCtx` a caller can hand
 *    straight to `runPipeline` (pipeline/runner/run.ts).
 *
 * `wire()` ties the checks assembly to the REAL registry (built inline
 * below, alongside the live adapter construction — the only two places
 * adapters are constructed) and returns `{ ctx, stages, routines, checks }`.
 *
 * There is deliberately no `wireScheduler()`/`Scheduler` port here anymore
 * (D14): `src/ports/scheduler.ts` and `src/adapters/scheduler/launchd/`
 * were deleted wholesale once the in-process daemon (`jobbunny serve
 * start|stop|status`, `src/ops/daemon/`, `src/cli/commands/serve.ts`)
 * replaced launchd triggering. The `Scheduler` interface's `install`/
 * `remove`/`list` semantics described registering jobs with an external OS
 * registry — a concept a live daemon doesn't have. No successor port
 * replaces it; the daemon is not a `Scheduler` implementation.
 */
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type {
  CdpChromeProviderDeps,
  CdpReachableFn,
} from '../adapters/browser/cdp-chrome/index.ts';
import {
  CdpChromeProvider,
  cdpReachableCheck,
  DEFAULT_CDP_PORT,
  defaultCdpReachable,
} from '../adapters/browser/cdp-chrome/index.ts';
import type { NotionApiLike, NotionSdkClientLike } from '../adapters/db/notion/index.ts';
import {
  dbReachableCheck,
  NotionApi,
  NotionConnector,
  NotionConnectorSettingsSchema,
} from '../adapters/db/notion/index.ts';
import { GreenhouseLane } from '../adapters/lanes/greenhouse/index.ts';
import { KekaLane } from '../adapters/lanes/keka/index.ts';
import {
  inventoryFreshnessCheck,
  LinkedInLane,
  loadInventory,
  parseSearchUrls,
} from '../adapters/lanes/linkedin/index.ts';
import {
  ClaudeCliProvider,
  type ClaudeCliProviderOptions,
} from '../adapters/llm/claude-cli/index.ts';
import {
  botTokenCheck,
  TelegramNotifier,
  TelegramNotifierSettingsSchema,
} from '../adapters/notify/telegram/index.ts';
import type { RegistryPolicy } from '../core/company/schema.ts';
import type { PipelineConfig } from '../core/config/schema.ts';
import { PipelineConfigSchema } from '../core/config/schema.ts';
import type { FilterConfig } from '../core/filter/config.ts';
import { FilterConfigSchema } from '../core/filter/config.ts';
import { RankConfigSchema } from '../core/rank/index.ts';
import { coreChecks } from '../ops/doctor/aggregate.ts';
import type { PipelineCtx, WiredPorts } from '../pipeline/runner/context.ts';
import { FsStorage } from '../pipeline/runner/fs_storage.ts';
import type { StageDef, StagePayload } from '../pipeline/runner/stage.ts';
import {
  assembleStage,
  compressStage,
  dedupStage,
  makeFarmStage,
  makeFilterStage,
  makeRankStage,
  makeReconcileStage,
  makeSourceStage,
  makeStructureStage,
  makeSyncStage,
} from '../pipeline/stages/index.ts';
import type { DoctorCheck } from '../ports/doctor.ts';
import type { ApiLane, FarmingLane, Lane } from '../ports/lane.ts';
import type { Storage } from '../ports/storage.ts';
import { cleanupRoutine } from '../routines/cleanup/index.ts';
import type { Routine } from '../routines/types.ts';

// --- shared IO-injection deps ---

export interface ConfigLoaderDeps {
  root?: string;
  readFile?: (path: string) => Promise<string>;
}

function resolveRoot(deps: ConfigLoaderDeps): string {
  return deps.root ?? process.cwd();
}

function resolveReadFile(deps: ConfigLoaderDeps): (path: string) => Promise<string> {
  return deps.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
}

function isNotFound(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: unknown }).code === 'ENOENT',
  );
}

// --- config loaders ---

/** Reads + validates `profiles/<name>/profile.json`. Fail-loud: a missing
 * file, invalid JSON, or schema mismatch all throw — the pipeline can't be
 * wired without a valid config. */
export async function loadPipelineConfig(
  profileName: string,
  deps: ConfigLoaderDeps = {},
): Promise<PipelineConfig> {
  const readFile = resolveReadFile(deps);
  const filePath = path.join(resolveRoot(deps), 'profiles', profileName, 'profile.json');
  const raw = await readFile(filePath);
  return PipelineConfigSchema.parse(JSON.parse(raw));
}

/** Reads + validates `profiles/<name>/filter.json`. The file is
 * optional (missing ⇒ `undefined`); present-but-invalid still throws —
 * this isn't a doctor check, so it never soft-fails. */
export async function loadFilterConfig(
  profileName: string,
  deps: ConfigLoaderDeps = {},
): Promise<FilterConfig | undefined> {
  const readFile = resolveReadFile(deps);
  const filePath = path.join(resolveRoot(deps), 'profiles', profileName, 'filter.json');
  let raw: string;
  try {
    raw = await readFile(filePath);
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  return FilterConfigSchema.parse(JSON.parse(raw));
}

// --- registry + pure assembly ---

/** Shared runtime handles the real check factories need. In tests this is
 * a throwaway fake object — `assembleAdapterChecks` never inspects it
 * itself, only hands it to whichever factory the config names. */
export interface RuntimeDeps {
  /** Repo-root-rooted. Inventories
   * (`src/adapters/lanes/linkedin/page_inventory/<page>.json`) are
   * machine-shared, NOT per-profile — this handle exists to reach them and
   * nothing else. Per-stage artifacts go through `profileStorage`. */
  storage: Storage;
  /** Rooted at `profiles/<name>/data` — every per-profile artifact
   * (cache, registry, structure, lane resume/capture state). */
  profileStorage: Storage;
  /** `undefined` when `NotionApi` construction failed (e.g. `NOTION_TOKEN`
   * missing) — `wire()` swallows that throw so doctor assembly never
   * crashes; `coreChecks`' `envTokensCheck` already reports the missing
   * token as its own `red` finding, so the `notion` connector factory
   * below just skips `dbReachableCheck` rather than double-reporting. */
  notionApi: NotionApiLike | undefined;
  browserReachable: CdpReachableFn;
  cdpPort: number;
  filterCfg?: FilterConfig;
  pages: string[];
}

/** Builds the `DoctorCheck[]` one lane/connector/notifier contributes.
 * Responsible for validating its own `settings` slice (a bad slice throws
 * via the adapter's own zod schema). */
export type CheckFactory = (settings: unknown, deps: RuntimeDeps) => DoctorCheck[];

export interface AdapterRegistry {
  lanes: Record<string, CheckFactory>;
  connectors: Record<string, CheckFactory>;
  notifiers: Record<string, CheckFactory>;
}

function resolveFactory(
  kind: 'lane' | 'connector' | 'notifier',
  registry: Record<string, CheckFactory>,
  name: string,
): CheckFactory {
  const factory = registry[name];
  if (!factory) throw new Error(`unknown ${kind} "${name}"`);
  return factory;
}

/** PURE — no IO, no adapter imports needed for its own logic. Resolves
 * `config.lanes`, `config.connector`, and `config.notifiers` against
 * `registry`, in that order, calling each factory with `config.settings[name]`
 * and `deps`, and concatenating every check contributed. Unknown names
 * throw loud, naming the offending kind + name. */
export function assembleAdapterChecks(
  config: PipelineConfig,
  registry: AdapterRegistry,
  deps: RuntimeDeps,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  for (const laneName of config.lanes) {
    const factory = resolveFactory('lane', registry.lanes, laneName);
    checks.push(...factory(config.settings[laneName], deps));
  }

  const connectorFactory = resolveFactory(
    'connector',
    registry.connectors,
    config.connector,
  );
  checks.push(...connectorFactory(config.settings[config.connector], deps));

  for (const notifierName of config.notifiers) {
    const factory = resolveFactory('notifier', registry.notifiers, notifierName);
    checks.push(...factory(config.settings[notifierName], deps));
  }

  return checks;
}

// --- real registry (the only adapter construction in this codebase) ---

// Default inventory-freshness ceiling (days) when the linkedin lane's
// settings don't specify one (§10 P9 closure register item 6 — was
// hardcoded at the `inventoryFreshnessCheck` call site with no way for a
// profile to override it).
const DEFAULT_INVENTORY_MAX_AGE_DAYS = 30;

/** Loosely reads an optional `maxAgeDays` off the linkedin lane's settings
 * blob (typed `unknown` here — its full shape is owned by the adapter,
 * `src/adapters/lanes/linkedin/**`, out of scope for this change) without
 * requiring a schema import from that package. Anything other than a
 * positive finite number (missing, wrong type, 0, negative, NaN) falls
 * back to the default rather than risk `inventoryFreshnessCheck` treating a
 * bad value as "everything is stale" or "nothing ever goes stale". */
export function resolveInventoryMaxAgeDays(settings: unknown): number {
  const candidate = (settings as { maxAgeDays?: unknown } | null | undefined)?.maxAgeDays;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
    ? candidate
    : DEFAULT_INVENTORY_MAX_AGE_DAYS;
}

const realRegistry: AdapterRegistry = {
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
      cdpReachableCheck({ reachable: deps.browserReachable, port: deps.cdpPort }),
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
  },
  notifiers: {
    telegram: (settings) => {
      TelegramNotifierSettingsSchema.parse(settings);
      return [botTokenCheck()];
    },
  },
};

// --- live adapter construction (ctx/ports/stages/routines) ---

/** A `NotionSdkClientLike` every method of which throws the same
 * config-problem message. Used to build a `NotionApi` (not merely a
 * `NotionApiLike`) when `NOTION_TOKEN` is missing, so `wire()` itself never
 * throws (doctor must survive a missing token — `coreChecks` already
 * reports it as a red) while the live connector still fails LOUD at first
 * actual use (`rebuildCache`/`syncJobs`/`archiveStale`), never silently. */
function missingTokenNotionClient(): NotionSdkClientLike {
  const fail = (): never => {
    throw new Error('NOTION_TOKEN missing — set it in .env');
  };
  return {
    databases: { query: fail },
    pages: { create: fail, update: fail },
  };
}

function buildConnector(name: string, settings: unknown, api: NotionApi) {
  if (name === 'notion') return new NotionConnector(settings, api);
  throw new Error(`unknown connector "${name}"`);
}

function buildNotifier(name: string, settings: unknown) {
  if (name === 'telegram') return new TelegramNotifier(settings);
  throw new Error(`unknown notifier "${name}"`);
}

function buildRoutine(name: string): Routine {
  if (name === 'cleanup') return cleanupRoutine;
  throw new Error(`unknown routine "${name}"`);
}

function isFarmingLane(lane: Lane): lane is FarmingLane {
  return lane.kind === 'farming';
}

function isApiLane(lane: Lane): lane is ApiLane {
  return lane.kind === 'api';
}

interface LiveLaneDeps {
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
async function buildLanes(config: PipelineConfig, deps: LiveLaneDeps): Promise<Lane[]> {
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
  );
}

/** `RegistryPolicy` defaults for `makeSourceStage`, overridable per-profile
 * via `settings.registry`. */
const DEFAULT_REGISTRY_POLICY: RegistryPolicy = {
  reprobeNotFoundAfterDays: 30,
  maxProbeFailures: 3,
  staleAfterFetchFailures: 3,
};

/** `maxProbesPerRun` default for `makeSourceStage`'s `opts`, overridable
 * via `settings.source`. */
const DEFAULT_MAX_PROBES_PER_RUN = 25;

/** Per-lane backstop cap on new jobs the generic api-lane source stage
 * emits per run (P9 closure register §1, Task A) — v0 parity: GH_MAX_NEW/
 * KEKA_MAX_NEW both default 40 (scripts/pipeline/{greenhouse,keka}.js).
 * Overridable per-profile via `settings.source.maxNewPerLane`. */
const DEFAULT_MAX_NEW_PER_LANE = 40;

/** Per-url backstop cap on how many gate-passed LinkedIn cards get an
 * expensive JD open in one run (P9 closure register §1, Task B) — no v0
 * equivalent existed for the LinkedIn lane; this default just sits in the
 * same range as the ATS lanes' cap. Overridable per-profile via
 * `settings.linkedin.maxCardsPerUrl`. */
const DEFAULT_MAX_CARDS_PER_URL = 40;

/** Loosely reads an optional `maxCardsPerUrl` off the linkedin lane's
 * settings blob, same posture as `resolveInventoryMaxAgeDays` above: any
 * non-positive/non-finite/missing value falls back to the default rather
 * than risk the lane treating a bad value as "open nothing" or "no cap at
 * all". */
export function resolveMaxCardsPerUrl(settings: unknown): number {
  const candidate = (settings as { maxCardsPerUrl?: unknown } | null | undefined)
    ?.maxCardsPerUrl;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
    ? candidate
    : DEFAULT_MAX_CARDS_PER_URL;
}

/** Live pacing defaults for the linkedin lane (throttle guard D2/D3,
 * 2026-07-28). Raised from the old v0-parity (2000, 5000) after LinkedIn
 * soft-throttled the shared `.chrome-debug` session under that cadence: 21
 * saved-search urls x 5 fires/day at ~1 navigation per 12s read as a burst.
 * Kept here (not just in the lane) so a profile with no `settings.linkedin`
 * pacing keys at all still gets a fully-populated, schema-validated range —
 * the lane's own defaults stay a no-op `(0, 0)` for tests. */
const DEFAULT_JITTER_MIN_MS = 5_000;
const DEFAULT_JITTER_MAX_MS = 12_000;

/** Pause between saved-search urls (D2). Together with the jitter above
 * this puts a 21-url fire at roughly 25 minutes against farm's unchanged
 * 90-minute ceiling — deliberately the moderate tier, since the
 * conservative one (~50 min) would eventually force raising that ceiling. */
const DEFAULT_INTER_URL_DELAY_MIN_MS = 20_000;
const DEFAULT_INTER_URL_DELAY_MAX_MS = 45_000;

/** Unlike `resolveMaxCardsPerUrl`/`resolveInventoryMaxAgeDays` (silently
 * fall back to a default on any bad value), an operator-set pacing range
 * that doesn't make sense (min > max, or either negative) is a
 * config-authoring mistake, not "value absent" — fail LOUD (zod throws),
 * same posture as `NotionConnectorSettingsSchema.parse`/
 * `TelegramNotifierSettingsSchema.parse` above. Missing keys still default
 * quietly, only a present-but-invalid value throws.
 *
 * Both pacing pairs share one schema (D3): they are read from the same
 * `settings.linkedin` blob and validated together, so a profile cannot end
 * up with a valid inter-url range sitting next to an inverted jitter one. */
const LinkedinPacingSettingsSchema = z
  .object({
    jitterMinMs: z.number().min(0).default(DEFAULT_JITTER_MIN_MS),
    jitterMaxMs: z.number().min(0).default(DEFAULT_JITTER_MAX_MS),
    interUrlDelayMinMs: z.number().min(0).default(DEFAULT_INTER_URL_DELAY_MIN_MS),
    interUrlDelayMaxMs: z.number().min(0).default(DEFAULT_INTER_URL_DELAY_MAX_MS),
  })
  .refine((v) => v.jitterMinMs <= v.jitterMaxMs, {
    message: 'settings.linkedin.jitterMinMs must be <= settings.linkedin.jitterMaxMs',
  })
  .refine((v) => v.interUrlDelayMinMs <= v.interUrlDelayMaxMs, {
    message:
      'settings.linkedin.interUrlDelayMinMs must be <= settings.linkedin.interUrlDelayMaxMs',
  });

/** Parses `settings.linkedin`'s `jitterMinMs`/`jitterMaxMs` pair — throws
 * (fail loud) on a negative value or `jitterMinMs > jitterMaxMs`; missing
 * settings (`undefined`/`{}`) fall back to the throttle-guard defaults. */
export function resolveJitterRange(settings: unknown): { minMs: number; maxMs: number } {
  const parsed = LinkedinPacingSettingsSchema.parse(settings ?? {});
  return { minMs: parsed.jitterMinMs, maxMs: parsed.jitterMaxMs };
}

/** Parses `settings.linkedin`'s `interUrlDelayMinMs`/`interUrlDelayMaxMs`
 * pair — same fail-loud posture and same schema as `resolveJitterRange`. */
export function resolveInterUrlDelayRange(settings: unknown): {
  minMs: number;
  maxMs: number;
} {
  const parsed = LinkedinPacingSettingsSchema.parse(settings ?? {});
  return { minMs: parsed.interUrlDelayMinMs, maxMs: parsed.interUrlDelayMaxMs };
}

/** Loosely reads an optional `maxNewPerLane` off the generic api-lane
 * source stage's settings blob (`settings.source`), same posture as
 * `resolveMaxCardsPerUrl`/`resolveInventoryMaxAgeDays`. */
export function resolveMaxNewPerLane(settings: unknown): number {
  const candidate = (settings as { maxNewPerLane?: unknown } | null | undefined)
    ?.maxNewPerLane;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
    ? candidate
    : DEFAULT_MAX_NEW_PER_LANE;
}

// --- wire() ---

export interface WireOverrides {
  registry?: AdapterRegistry;
  deps?: Partial<RuntimeDeps>;
  root?: string;
  readFile?: (path: string) => Promise<string>;
  /** P8 Task 7: when set, threaded straight into `makeSyncStage`'s
   * `dryRunPath` opt — the sync stage writes the would-write set there
   * instead of calling `connector.syncJobs`. `undefined` (the default)
   * keeps the existing live-write behavior unchanged. */
  syncDryRunPath?: string;
}

export interface WireResult {
  ctx: PipelineCtx;
  stages: Array<StageDef<StagePayload, StagePayload>>;
  routines: Routine[];
  checks: DoctorCheck[];
}

/** Composition for one profile: loads config, resolves the REAL adapter
 * registry for doctor checks, builds the live ports/stages/routines, and
 * returns `{ ctx, stages, routines, checks }` — everything a caller needs
 * for both `/doctor` (checks) and an actual run (`ctx`/`stages` handed to
 * `pipeline/runner/run.ts`'s `runPipeline`, `routines` invoked at their
 * declared `when`). */
export async function wire(
  profileName: string,
  overrides: WireOverrides = {},
): Promise<WireResult> {
  const root = overrides.root ?? process.cwd();
  const readFile = overrides.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));

  const config = await loadPipelineConfig(profileName, { root, readFile });
  const filterCfg = await loadFilterConfig(profileName, { root, readFile });

  const searchUrlsPath = path.join(root, 'profiles', profileName, 'search_urls.md');
  let pages: string[] = [];
  try {
    const md = await readFile(searchUrlsPath);
    pages = [...new Set(parseSearchUrls(md).map((group) => group.page))];
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  // `notionApiForConnector` is ALWAYS a real `NotionApi` instance — either
  // the genuine one (token present) or one built over a throwing stub
  // client (token missing) — so the live `NotionConnector` below always has
  // something to hold, never `undefined`. `notionApi` (the narrower
  // `NotionApiLike | undefined`) stays exactly as before for the doctor
  // check path: `undefined` on a missing token, since `dbReachableCheck`
  // must not run against the throwing stub (it would just report a red for
  // a problem `envTokensCheck` already reports).
  let notionApi: NotionApiLike | undefined;
  let notionApiForConnector: NotionApi;
  try {
    const realApi = new NotionApi();
    notionApi = realApi;
    notionApiForConnector = realApi;
  } catch {
    // `NotionApi`'s constructor throws when `NOTION_TOKEN` is missing —
    // that's already surfaced as a red by `coreChecks`' `envTokensCheck`,
    // so wiring must not crash here; leave the handle undefined instead.
    notionApi = undefined;
    notionApiForConnector = new NotionApi({ client: missingTokenNotionClient() });
  }

  // TWO storage handles, deliberately.
  // `src/adapters/lanes/linkedin/page_inventory/<page>.json` is
  // machine-shared (repo-root-relative) and is not per-profile, while every
  // stage artifact (`cache/`, `registry/`, `structure/`, the LinkedIn lane's
  // resume/capture state) IS. Rooting a single handle at the repo root — as
  // this did until 2026-07-25 — put all of them in the repo root and made
  // two profiles share one cache and one company registry. That is not
  // cosmetic: the first real run read a 0-entry repo-root
  // `registry/companies.json` it had just created instead of the profile's
  // 27 curated companies, so the Greenhouse and Keka lanes probed nothing
  // and the run still reported `passed`.
  const storage = new FsStorage(root);
  const profileStorage = new FsStorage(path.join(root, 'profiles', profileName, 'data'));

  const deps: RuntimeDeps = {
    storage,
    profileStorage,
    notionApi,
    browserReachable: defaultCdpReachable,
    cdpPort: DEFAULT_CDP_PORT,
    filterCfg,
    pages,
    ...overrides.deps,
  };
  const registry = overrides.registry ?? realRegistry;

  const checks = [
    ...coreChecks({ profileName, root, readFile }),
    ...assembleAdapterChecks(config, registry, deps),
  ];

  // --- live ports ---
  // llm/browser are NOT part of PipelineConfig (spec: selected by
  // convention, not config-driven) — always constructed, settings sliced
  // from `settings['claude-cli']`/`settings['cdp-chrome']` if present.
  const llm = new ClaudeCliProvider(
    (config.settings['claude-cli'] as ClaudeCliProviderOptions | undefined) ?? {},
  );
  const browser = new CdpChromeProvider({
    port: deps.cdpPort,
    ...((config.settings['cdp-chrome'] as CdpChromeProviderDeps | undefined) ?? {}),
  });

  const lanes = await buildLanes(config, {
    profileName,
    root,
    readFile,
    storage: deps.storage,
    profileStorage: deps.profileStorage,
    filterCfg,
    browser,
  });
  const connector = buildConnector(
    config.connector,
    config.settings[config.connector],
    notionApiForConnector,
  );
  const notifiers = config.notifiers.map((name) =>
    buildNotifier(name, config.settings[name]),
  );
  const routines = config.routines.map((name) => buildRoutine(name));

  const ports: WiredPorts = { lanes, connector, notifiers, llm, browser };

  const ctx: PipelineCtx = {
    profile: profileName,
    // Placeholder — `runPipeline` (pipeline/runner/run.ts) replaces this
    // with `AbortSignal.any([ctx.signal, AbortSignal.timeout(runCapMs)])`
    // before running any stage, so this is never the signal a stage
    // actually observes.
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    // Placeholder no-op — `guardStage` (pipeline/runner/guard.ts) never
    // calls the top-level `ctx.beat` directly; it builds its own
    // stall-arming `childCtx.beat` per attempt (wrapping this one) and
    // hands THAT to `stage.run`, so this is never the beat a stage actually
    // calls.
    beat() {},
    storage: profileStorage,
    config,
    ports,
    // A notifier failure (e.g. Telegram's `send()` throwing on a missing
    // token or a hung request) must never change the run's outcome — `run.ts`
    // calls this AFTER `runPipeline` has already produced a PASSED/FAILED
    // `RunResult`, so an unhandled rejection here would escape to `main.ts`'s
    // catch and turn an otherwise-passed run into exit 1 (and skip the
    // funnel summary print that follows). `Promise.allSettled` + per-notifier
    // logging keeps every send independent and never throws.
    async notify(event) {
      const results = await Promise.allSettled(ports.notifiers.map((n) => n.send(event)));
      for (const [i, result] of results.entries()) {
        if (result.status === 'rejected') {
          const name = ports.notifiers[i]?.name ?? `notifier[${i}]`;
          const reason =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          ctx.logger.error(`notify: ${name} failed: ${reason}`);
        }
      }
    },
  };

  const registryPolicy: RegistryPolicy = {
    ...DEFAULT_REGISTRY_POLICY,
    ...(config.settings.registry as Partial<RegistryPolicy> | undefined),
  };
  const rankCfg = RankConfigSchema.parse(config.settings.rank ?? {});
  const filterCfgForStage = filterCfg ?? FilterConfigSchema.parse({});
  const sourceOpts = {
    maxProbesPerRun: DEFAULT_MAX_PROBES_PER_RUN,
    // Card gate (title/company avoid) applied to every fetched api-lane
    // job before the seen/cache skip and the maxNewPerLane cap — same
    // FilterConfig the filter stage uses later, so a job the source stage
    // lets through was always going to survive `filter` too (P9 closure
    // register §1, Task A).
    filterCfg: filterCfgForStage,
    maxNewPerLane: resolveMaxNewPerLane(config.settings.source),
    ...(config.settings.source as
      | Partial<{ maxProbesPerRun: number; laneBudgetMs: number; maxNewPerLane: number }>
      | undefined),
  };

  const farmingLanes = lanes.filter(isFarmingLane);
  const apiLanes = lanes.filter(isApiLane);

  const stages: Array<StageDef<StagePayload, StagePayload>> = [
    makeReconcileStage(connector),
    makeFarmStage(farmingLanes),
    makeSourceStage(apiLanes, registryPolicy, sourceOpts),
    compressStage,
    makeStructureStage(llm),
    assembleStage,
    makeFilterStage(filterCfgForStage),
    dedupStage,
    makeRankStage(rankCfg),
    makeSyncStage(connector, { dryRunPath: overrides.syncDryRunPath }),
  ];

  return { ctx, stages, routines, checks };
}
