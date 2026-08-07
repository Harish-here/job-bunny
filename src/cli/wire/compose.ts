/**
 * cli/wire/compose.ts (P8, split from wire.ts) — the single composition
 * point permitted to import from `src/adapters/**`
 * (`only-wire-imports-adapters` in `.dependency-cruiser.cjs`, alongside
 * `registry.ts` for two TYPE-ONLY exceptions — see that file's doc
 * comment). Everything else — `pipeline/`, `routines/`, `ops/`, and every
 * other file under `src/cli` (including this module's own tests) — reaches
 * adapters only through what `wire()` hands back.
 *
 * Live composition: `realRegistry` (`builders.ts` — the REAL
 * `AdapterRegistry` behind `registry.ts`'s pure `assembleAdapterChecks`)
 * plus `wire()`'s ctx/stages/routines build resolve
 * `PipelineConfig.lanes/connector/notifiers/routines` against real adapter
 * constructors (unknown name ⇒ loud throw, same posture as `registry.ts`'s
 * `resolveFactory`) and assemble the frozen 10-stage job-flow plus a
 * `PipelineCtx` a caller can hand straight to `runPipeline`
 * (pipeline/runner/run.ts). Returns a `WireResult` (below) — its
 * `configStore` is NOT closed internally; see that field's own doc comment.
 * No `wireScheduler()`/`Scheduler` port (D14): the in-process daemon
 * (`src/ops/daemon/`) replaced launchd triggering; no successor port exists.
 */
import path from 'node:path';
import type { CdpChromeProviderDeps } from '../../adapters/browser/cdp-chrome/index.ts';
import {
  CdpChromeProvider,
  DEFAULT_CDP_PORT,
  defaultCdpReachable,
} from '../../adapters/browser/cdp-chrome/index.ts';
import type { NotionApiLike } from '../../adapters/db/notion/index.ts';
import { NotionApi } from '../../adapters/db/notion/index.ts';
import { SqliteCheckpointStore } from '../../adapters/db/sqlite/checkpoints/index.ts';
import { SqliteConfigStore } from '../../adapters/db/sqlite/config/index.ts';
import { sqliteDbCheck } from '../../adapters/db/sqlite/index.ts';
import { SqliteRunStore } from '../../adapters/db/sqlite/runs/index.ts';
import { SqliteStateStore } from '../../adapters/db/sqlite/state/index.ts';
import { parseSearchUrls } from '../../adapters/lanes/linkedin/index.ts';
import {
  ClaudeCliProvider,
  type ClaudeCliProviderOptions,
} from '../../adapters/llm/claude-cli/index.ts';
import type { RegistryPolicy } from '../../core/company/schema.ts';
import { FilterConfigSchema } from '../../core/filter/config.ts';
import { RankConfigSchema } from '../../core/rank/index.ts';
import { coreChecks } from '../../ops/doctor/aggregate.ts';
import { createWireLogger } from '../../ops/observability/index.ts';
import type { PipelineCtx, WiredPorts } from '../../pipeline/runner/context.ts';
import { FsStorage } from '../../pipeline/runner/fs_storage.ts';
import type { StageDef, StagePayload } from '../../pipeline/runner/stage.ts';
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
} from '../../pipeline/stages/index.ts';
import type { ConfigStore } from '../../ports/config_store.ts';
import type { DoctorCheck } from '../../ports/doctor.ts';
import type { Routine } from '../../routines/types.ts';
import {
  assertSqlitePathRetired,
  buildConnector,
  buildLanes,
  buildMirroredConnector,
  buildNotifier,
  buildRoutine,
  canonicalDbPath,
  isApiLane,
  isFarmingLane,
  mirrorDbId,
  mirrorReachableCheck,
  missingTokenNotionClient,
  realRegistry,
} from './builders.ts';
import { loadFilterConfig, loadPipelineConfig } from './config.ts';
import type { AdapterRegistry, RuntimeDeps } from './registry.ts';
import { assembleAdapterChecks } from './registry.ts';
import {
  DEFAULT_MAX_PROBES_PER_RUN,
  DEFAULT_REGISTRY_POLICY,
  resolveLoggingSettings,
  resolveMaxNewPerLane,
} from './settings.ts';

// --- wire() ---

export interface WireOverrides {
  registry?: AdapterRegistry;
  deps?: Partial<RuntimeDeps>;
  root?: string;
  /** Test-only seam (mirrors `deps`/`registry`) — real callers never set
   * this; `wire()` builds a real `SqliteConfigStore` otherwise. */
  configStore?: ConfigStore;
  /** `'readonly'` for a caller (doctor) that must never create/migrate
   * `jobbunny.db`. Default `'readwrite'`; ignored when `configStore` is set. */
  configLiftMode?: 'readwrite' | 'readonly';
  /** Threaded into `makeSyncStage`'s `dryRun` opt: the sync stage records
   * the would-write set via `ctx.runStore.recordSyncDryrun` instead of
   * calling `connector.syncJobs`. `undefined` (default) is unchanged. */
  syncDryRun?: boolean;
}

export interface WireResult {
  ctx: PipelineCtx;
  stages: Array<StageDef<StagePayload, StagePayload>>;
  routines: Routine[];
  checks: DoctorCheck[];
  // Optional purely so the many pre-existing fake `WireResult` literals in
  // OTHER commands' test files (run.test.ts, stage.test.ts, state.test.ts —
  // none of which exercise this field) don't all need updating for a
  // config→db-Phase-4 concern that isn't theirs. The real `wire()` always
  // sets it. Not closed internally (checks close over it, run later) —
  // caller closes.
  configStore?: ConfigStore;
}

/** Composition for one profile: loads config, resolves the REAL adapter
 * registry for doctor checks, builds the live ports/stages/routines, and
 * returns a `WireResult` — everything a caller needs for both `/doctor`
 * (`checks`) and an actual run (`ctx`/`stages` handed to
 * `pipeline/runner/run.ts`'s `runPipeline`, `routines` invoked at their
 * declared `when`). */
export async function wire(
  profileName: string,
  overrides: WireOverrides = {},
): Promise<WireResult> {
  const root = overrides.root ?? process.cwd();
  const dbPath = canonicalDbPath(root, profileName);
  const profileRoot = path.join(root, 'profiles', profileName);
  const ownsConfigStore = overrides.configStore === undefined;
  const configStore =
    overrides.configStore ??
    new SqliteConfigStore(dbPath, profileRoot, { liftMode: overrides.configLiftMode });
  try {
    return await wireWithConfigStore(profileName, overrides, configStore);
  } catch (err) {
    // Anything wire() creates but never gets to RETURN (loadPipelineConfig
    // throwing "not found", buildLanes throwing, etc.) must not leak this
    // store's own open db handle — a caller-supplied `overrides.configStore`
    // is the caller's to close, never touched here.
    if (ownsConfigStore) configStore.close();
    throw err;
  }
}

/** The actual composition body — split out so `wire()` (above) can wrap it
 * in a try/catch that closes an own-created `configStore` on ANY throw
 * (loading, check-assembly, or lane/connector construction alike), without
 * reindenting this whole function. */
async function wireWithConfigStore(
  profileName: string,
  overrides: WireOverrides,
  configStore: ConfigStore,
): Promise<WireResult> {
  const root = overrides.root ?? process.cwd();
  const dbPath = canonicalDbPath(root, profileName);

  const config = await loadPipelineConfig(profileName, { configStore });
  assertSqlitePathRetired(config, profileName);
  const logging = resolveLoggingSettings(
    config.settings.logging,
    process.env.JOBBUNNY_TTY_LOG_LEVEL,
  );
  const filterCfg = await loadFilterConfig(profileName, { configStore });

  const searchUrlsRaw = await configStore.readText('search_urls.md');
  const urlGroups = searchUrlsRaw === undefined ? [] : parseSearchUrls(searchUrlsRaw);
  const pages = [...new Set(urlGroups.map((g) => g.page))];

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

  // TWO storage handles, deliberately: `page_inventory/<page>.json` is
  // machine-shared (repo-root), while every stage artifact (`cache/`,
  // `registry/`, `structure/`, the LinkedIn lane's resume/capture state) is
  // per-profile. A single repo-root handle (pre-2026-07-25) made two
  // profiles share one cache/registry — the first real run read a 0-entry
  // repo-root `registry/companies.json` instead of the profile's 27 curated
  // companies, so Greenhouse/Keka probed nothing and the run still passed.
  const storage = new FsStorage(root);
  const profileStorage = new FsStorage(path.join(root, 'profiles', profileName, 'data'));
  // `SqliteRunStore` opens lazily (ledger L13) — no file I/O here. `dbPath`
  // is THE authoritative jobbunny.db location (canonicalDbPath, above).
  const runStore = new SqliteRunStore(dbPath);
  // Shares `dbPath` with `runStore` — lazy-open, no file I/O here either.
  const checkpointStore = new SqliteCheckpointStore(dbPath);
  const stateStore = new SqliteStateStore(
    dbPath,
    path.join(root, 'profiles', profileName, 'data'), // mirrors `profileStorage`'s root
  );

  const deps: RuntimeDeps = {
    storage,
    profileStorage,
    notionApi,
    browserReachable: defaultCdpReachable,
    cdpPort: DEFAULT_CDP_PORT,
    filterCfg,
    pages,
    sqliteDefaultPath: dbPath,
    ...overrides.deps,
  };
  const registry = overrides.registry ?? realRegistry;

  const mirrorTarget = mirrorDbId(config);
  const checks = [
    ...coreChecks({
      profileName,
      root,
      // The four profile/filter config checks read through the SAME
      // `ConfigStore` this call already built — a config-docs-only
      // profile is never falsely reported "not found" (fix round;
      // direct-fs `readFile` reads are retired).
      readDoc: (key) => configStore.readText(key),
      connector: config.connector,
      notionMirror: mirrorTarget !== '',
    }),
    ...assembleAdapterChecks(config, registry, deps),
  ];
  // `sqlite` connectors already get `sqlite-db-openable` from
  // `assembleAdapterChecks` above — add it here only for every other
  // connector, so every profile gets it exactly once.
  if (config.connector !== 'sqlite') checks.push(sqliteDbCheck({ path: dbPath }));
  // Opt-in sqlite→Notion mirror (local-DB spec PR 3): a mirrored profile
  // gets a `notion-db-reachable` check too, on top of whatever
  // `assembleAdapterChecks` already contributed for `sqlite` — but through
  // `mirrorReachableCheck` (I2), not the raw `dbReachableCheck` a plain
  // `notion` connector gets: a broken mirror never impairs the sqlite
  // source of truth a mirrored profile actually runs on, so its `red`
  // findings are downgraded to `warn`.
  if (mirrorTarget && deps.notionApi) {
    checks.push(mirrorReachableCheck({ api: deps.notionApi, dbId: mirrorTarget }));
  }

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
    configStore,
    storage: deps.storage,
    stateStore,
    filterCfg,
    browser,
  });
  const connector = buildMirroredConnector(
    buildConnector(
      config.connector,
      config.settings[config.connector],
      notionApiForConnector,
      dbPath,
    ),
    config,
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
    logger: createWireLogger({ ttyLevel: logging.ttyLevel }),
    // Placeholder no-op — `guardStage` (pipeline/runner/guard.ts) never
    // calls the top-level `ctx.beat` directly; it builds its own
    // stall-arming `childCtx.beat` per attempt (wrapping this one) and
    // hands THAT to `stage.run`, so this is never the beat a stage actually
    // calls.
    beat() {},
    storage: profileStorage,
    config,
    ports,
    runStore,
    checkpointStore,
    stateStore,
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
    makeSyncStage(connector, { dryRun: overrides.syncDryRun }),
  ];

  return { ctx, stages, routines, checks, configStore };
}
