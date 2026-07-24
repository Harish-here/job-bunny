// Doctor-surface composition only; ctx/stages/routines assembly is a
// deferred Task 3 increment.
/**
 * cli/wire.ts (P8) — the single composition point permitted to import from
 * `src/adapters/**` (`only-wire-imports-adapters` in
 * `.dependency-cruiser.cjs`). Everything else — `pipeline/`, `routines/`,
 * `ops/`, and every other file under `src/cli` (including this file's own
 * test) — reaches adapters only through what `wire()` hands back.
 *
 * Two independent things live here:
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
 *
 * `wire()` ties both to the REAL registry (built inline below, the only
 * place adapters are constructed) and returns `{ checks }` — the doctor
 * surface only. It does not build `ctx`, `stages`, or `routines`; that is
 * explicitly out of scope here (see the file-top comment) and left to a
 * later Task 3 increment.
 */
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import type { CdpReachableFn } from '../adapters/browser/cdp-chrome/index.ts';
import {
  cdpReachableCheck,
  DEFAULT_CDP_PORT,
  defaultCdpReachable,
} from '../adapters/browser/cdp-chrome/index.ts';
import type { NotionApiLike } from '../adapters/db/notion/index.ts';
import {
  dbReachableCheck,
  NotionApi,
  NotionConnectorSettingsSchema,
} from '../adapters/db/notion/index.ts';
import {
  inventoryFreshnessCheck,
  parseSearchUrls,
} from '../adapters/lanes/linkedin/index.ts';
import {
  botTokenCheck,
  TelegramNotifierSettingsSchema,
} from '../adapters/notify/telegram/index.ts';
import type { PipelineConfig } from '../core/config/schema.ts';
import { PipelineConfigSchema } from '../core/config/schema.ts';
import type { FilterConfig } from '../core/filter/config.ts';
import { FilterConfigSchema } from '../core/filter/config.ts';
import { coreChecks } from '../ops/doctor/aggregate.ts';
import { FsStorage } from '../pipeline/runner/fs_storage.ts';
import type { DoctorCheck } from '../ports/doctor.ts';
import type { Storage } from '../ports/storage.ts';

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

// --- wire() ---

export interface WireOverrides {
  registry?: AdapterRegistry;
  deps?: Partial<RuntimeDeps>;
  root?: string;
  readFile?: (path: string) => Promise<string>;
}

export interface WireResult {
  checks: DoctorCheck[];
}

/** Doctor-surface composition for one profile: loads config, resolves the
 * REAL adapter registry, and returns the concatenated `DoctorCheck[]`
 * (core checks first, then adapter-contributed ones). Does NOT build a
 * runnable `ctx`/`stages`/`routines` — see the file-top comment. */
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

  let notionApi: NotionApiLike | undefined;
  try {
    notionApi = new NotionApi();
  } catch {
    // `NotionApi`'s constructor throws when `NOTION_TOKEN` is missing —
    // that's already surfaced as a red by `coreChecks`' `envTokensCheck`,
    // so wiring must not crash here; leave the handle undefined instead.
    notionApi = undefined;
  }

  const deps: RuntimeDeps = {
    storage: new FsStorage(root),
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
  return { checks };
}
