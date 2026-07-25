/**
 * cli/wire.ts (P8) — the single composition point permitted to import from
 * `src/adapters/**` (`only-wire-imports-adapters` in
 * `.dependency-cruiser.cjs`). Everything else — `pipeline/`, `routines/`,
 * `ops/`, and every other file under `src/cli` (including this file's own
 * test) — reaches adapters only through what `wire()` hands back.
 *
 * Three independent things live here:
 *  - Config loading (`loadPipelineConfig`/`loadFilterConfig`): reads
 *    `profiles/<name>/profile.json` / `filter_config.json`, parses, and
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
 */
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
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

/** Reads + validates `profiles/<name>/filter_config.json`. The file is
 * optional (missing ⇒ `undefined`); present-but-invalid still throws —
 * this isn't a doctor check, so it never soft-fails. */
export async function loadFilterConfig(
  profileName: string,
  deps: ConfigLoaderDeps = {},
): Promise<FilterConfig | undefined> {
  const readFile = resolveReadFile(deps);
  const filePath = path.join(
    resolveRoot(deps),
    'profiles',
    profileName,
    'filter_config.json',
  );
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
  storage: Storage;
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

const realRegistry: AdapterRegistry = {
  lanes: {
    // The CDP-reachability check rides with the browser-driven linkedin
    // lane rather than living on its own — nothing else in the registry
    // touches the browser.
    linkedin: (_settings, deps) => [
      // TODO: maxAgeDays is hardcoded to 30 — wire it from a configured
      // value once the linkedin lane's settings shape carries one.
      inventoryFreshnessCheck(deps.storage, deps.pages, 30),
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
  storage: Storage;
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
        lanes.push(await buildLinkedInLane(deps));
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

async function buildLinkedInLane(deps: LiveLaneDeps): Promise<LinkedInLane> {
  if (!deps.filterCfg) {
    throw new Error(
      `linkedin lane requires profiles/${deps.profileName}/filter_config.json (a FilterConfig)`,
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
  return new LinkedInLane(deps.browser, inventories, urls, deps.filterCfg, deps.storage);
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

// --- wire() ---

export interface WireOverrides {
  registry?: AdapterRegistry;
  deps?: Partial<RuntimeDeps>;
  root?: string;
  readFile?: (path: string) => Promise<string>;
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

  const storage = new FsStorage(root);

  const deps: RuntimeDeps = {
    storage,
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
    storage,
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
    storage,
    config,
    ports,
    async notify(event) {
      await Promise.all(ports.notifiers.map((n) => n.send(event)));
    },
  };

  const registryPolicy: RegistryPolicy = {
    ...DEFAULT_REGISTRY_POLICY,
    ...(config.settings.registry as Partial<RegistryPolicy> | undefined),
  };
  const sourceOpts = {
    maxProbesPerRun: DEFAULT_MAX_PROBES_PER_RUN,
    ...(config.settings.source as
      | Partial<{ maxProbesPerRun: number; laneBudgetMs: number }>
      | undefined),
  };
  const rankCfg = RankConfigSchema.parse(config.settings.rank ?? {});
  const filterCfgForStage = filterCfg ?? FilterConfigSchema.parse({});

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
    makeSyncStage(connector),
  ];

  return { ctx, stages, routines, checks };
}
