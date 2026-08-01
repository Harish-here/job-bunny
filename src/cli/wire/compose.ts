/**
 * cli/wire/compose.ts (P8, split from wire.ts) — the single composition
 * point permitted to import from `src/adapters/**`
 * (`only-wire-imports-adapters` in `.dependency-cruiser.cjs`, alongside
 * `registry.ts` for two TYPE-ONLY exceptions — see that file's doc
 * comment). Everything else — `pipeline/`, `routines/`, `ops/`, and every
 * other file under `src/cli` (including this module's own tests) — reaches
 * adapters only through what `wire()` hands back.
 *
 * Live composition: `realRegistry` (the REAL `AdapterRegistry` behind
 * `registry.ts`'s pure `assembleAdapterChecks`) plus `wire()`'s ctx/stages/
 * routines build resolve `PipelineConfig.lanes/connector/notifiers/routines`
 * against real adapter constructors (unknown name ⇒ loud throw, same
 * posture as `registry.ts`'s `resolveFactory`) and assemble the frozen
 * 10-stage job-flow plus a `PipelineCtx` a caller can hand straight to
 * `runPipeline` (pipeline/runner/run.ts).
 *
 * `wire()` ties the checks assembly to the REAL registry (built inline
 * below, alongside the live adapter construction — the only two places
 * adapters are constructed) and returns `{ ctx, stages, routines, checks }`.
 *
 * There is deliberately no `wireScheduler()`/`Scheduler` port here anymore
 * (D14): `src/ports/scheduler.ts` and `src/adapters/scheduler/launchd/`
 * were deleted wholesale once the in-process daemon (`jobbunny serve
 * start|stop|status`, `src/ops/daemon/`, `src/cli/commands/serve/`)
 * replaced launchd triggering. The `Scheduler` interface's `install`/
 * `remove`/`list` semantics described registering jobs with an external OS
 * registry — a concept a live daemon doesn't have. No successor port
 * replaces it; the daemon is not a `Scheduler` implementation.
 */
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import type { CdpChromeProviderDeps } from '../../adapters/browser/cdp-chrome/index.ts';
import {
  CdpChromeProvider,
  cdpReachableCheck,
  DEFAULT_CDP_PORT,
  defaultCdpReachable,
} from '../../adapters/browser/cdp-chrome/index.ts';
import type { NotionApiLike } from '../../adapters/db/notion/index.ts';
import {
  dbReachableCheck,
  NotionApi,
  NotionConnectorSettingsSchema,
} from '../../adapters/db/notion/index.ts';
import {
  SqliteConnectorSettingsSchema,
  sqliteDbCheck,
} from '../../adapters/db/sqlite/index.ts';
import {
  inventoryFreshnessCheck,
  parseSearchUrls,
} from '../../adapters/lanes/linkedin/index.ts';
import {
  ClaudeCliProvider,
  type ClaudeCliProviderOptions,
} from '../../adapters/llm/claude-cli/index.ts';
import {
  botTokenCheck,
  TelegramNotifierSettingsSchema,
} from '../../adapters/notify/telegram/index.ts';
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
import type { DoctorCheck } from '../../ports/doctor.ts';
import type { Routine } from '../../routines/types.ts';
import {
  buildConnector,
  buildLanes,
  buildMirroredConnector,
  buildNotifier,
  buildRoutine,
  isApiLane,
  isFarmingLane,
  mirrorDbId,
  mirrorReachableCheck,
  missingTokenNotionClient,
} from './builders.ts';
import { isNotFound, loadFilterConfig, loadPipelineConfig } from './config.ts';
import type { AdapterRegistry, RuntimeDeps } from './registry.ts';
import { assembleAdapterChecks } from './registry.ts';
import {
  DEFAULT_MAX_PROBES_PER_RUN,
  DEFAULT_REGISTRY_POLICY,
  resolveInventoryMaxAgeDays,
  resolveLoggingSettings,
  resolveMaxNewPerLane,
} from './settings.ts';

// --- real registry (the only adapter construction alongside builders.ts) ---

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
    sqlite: (settings, deps) => {
      const parsed = SqliteConnectorSettingsSchema.parse(settings ?? {});
      return [sqliteDbCheck({ path: parsed.path ?? deps.sqliteDefaultPath })];
    },
  },
  notifiers: {
    telegram: (settings) => {
      TelegramNotifierSettingsSchema.parse(settings);
      return [botTokenCheck()];
    },
  },
};

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
  const logging = resolveLoggingSettings(
    config.settings.logging,
    process.env.JOBBUNNY_TTY_LOG_LEVEL,
  );
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
  const sqliteDefaultPath = path.join(
    root,
    'profiles',
    profileName,
    'data',
    'jobbunny.db',
  );

  const deps: RuntimeDeps = {
    storage,
    profileStorage,
    notionApi,
    browserReachable: defaultCdpReachable,
    cdpPort: DEFAULT_CDP_PORT,
    filterCfg,
    pages,
    sqliteDefaultPath,
    ...overrides.deps,
  };
  const registry = overrides.registry ?? realRegistry;

  const mirrorTarget = mirrorDbId(config);
  const checks = [
    ...coreChecks({
      profileName,
      root,
      readFile,
      connector: config.connector,
      notionMirror: mirrorTarget !== '',
    }),
    ...assembleAdapterChecks(config, registry, deps),
  ];
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
    root,
    readFile,
    storage: deps.storage,
    profileStorage: deps.profileStorage,
    filterCfg,
    browser,
  });
  const connector = buildMirroredConnector(
    buildConnector(
      config.connector,
      config.settings[config.connector],
      notionApiForConnector,
      sqliteDefaultPath,
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
