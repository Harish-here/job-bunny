/**
 * cli/wire/registry.ts (P8, split from wire.ts) — adapter-check assembly:
 * `assembleAdapterChecks` + `AdapterRegistry` is a PURE function mapping
 * `PipelineConfig.lanes/connector/notifiers` names onto a registry of
 * `CheckFactory`s and concatenating the `DoctorCheck[]` each contributes.
 * This is the part under TDD via a FAKE registry in `registry.test.ts` — it
 * does no IO and needs no real adapter to exercise its
 * lookup/ordering/error-naming/settings-slicing behavior.
 *
 * Deviation from the `only-wire-imports-adapters` carve-out (compose.ts
 * only): `RuntimeDeps.notionApi`/`.browserReachable` are typed against two
 * adapter-owned structural interfaces (`NotionApiLike`,
 * `adapters/db/notion`; `CdpReachableFn`, `adapters/browser/cdp-chrome`) —
 * narrow shapes that predate this split. Duplicating those shapes locally
 * would drift from the adapters' real definitions, and moving them into
 * `ports/` would be a redesign out of this change's scope, so `registry.ts`
 * is exempted alongside `compose.ts` in `.dependency-cruiser.cjs` for these
 * TYPE-ONLY imports; it still constructs no adapter and does no IO itself.
 */
import type { CdpReachableFn } from '../../adapters/browser/cdp-chrome/index.ts';
import type { NotionApiLike } from '../../adapters/db/notion/index.ts';
import type { PipelineConfig } from '../../core/config/schema.ts';
import type { FilterConfig } from '../../core/filter/config.ts';
import type { DoctorCheck } from '../../ports/doctor.ts';
import type { Storage } from '../../ports/storage.ts';

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
  /** `profiles/<name>/data/jobbunny.db` — the ONE sqlite db location for
   * every profile (config→db Phase 4 retired `settings.sqlite.path`; the
   * check factory (`compose.ts`) uses this path unconditionally now, no
   * override to resolve). */
  sqliteDefaultPath: string;
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
