/**
 * cli/wire/config.ts (P8, split from wire.ts) — config loading:
 * `loadPipelineConfig`/`loadFilterConfig` read `profile.json`/`filter.json`
 * via an injected `ConfigStore` (config→db Phase 4 — no `readFile`/`root`
 * left; the store owns its own path resolution and legacy-file lift), parse,
 * and validate against the core schemas. This is fail-loud config, NOT a
 * doctor check — a missing/invalid `profile.json` throws immediately
 * (mirrors `ops/doctor/aggregate.ts`'s `profileParsesCheck`, which reports
 * the same failure as a `red` finding instead — the two are deliberately
 * redundant: one lets `/doctor` explain *why* wiring would fail without
 * throwing, the other actually enforces it at wire time).
 *
 * PURE — no `src/adapters/**` import, unlike `compose.ts`. `ConfigStore` is
 * a port type only; the concrete `SqliteConfigStore` is constructed in
 * `compose.ts`/`builders.ts`/`migrate.ts`, never here.
 *
 * ⚠️ Message-text deviation from the plan (config→db Phase 4 Task 4): the
 * missing-profile.json error below is NOT the raw `ENOENT` message today's
 * `readFile`-based version produced — there is no `fs` call in this path at
 * all now (the miss comes from `ConfigStore.readText` returning
 * `undefined`), so there is no `ENOENT` to surface. The BEHAVIOR (throws
 * loud on a missing profile.json) is preserved; the exact TEXT is a new,
 * deliberately-worded replacement.
 */
import type { PipelineConfig } from '../../core/config/schema.ts';
import { PipelineConfigSchema } from '../../core/config/schema.ts';
import type { FilterConfig } from '../../core/filter/config.ts';
import { FilterConfigSchema } from '../../core/filter/config.ts';
import type { ConfigStore } from '../../ports/config_store.ts';

// --- shared IO-injection deps ---

export interface ConfigLoaderDeps {
  configStore: ConfigStore;
}

// --- config loaders ---

/** Reads + validates `profile.json`. Fail-loud: a missing doc/file,
 * invalid JSON, or schema mismatch all throw — the pipeline can't be wired
 * without a valid config. */
export async function loadPipelineConfig(
  profileName: string,
  deps: ConfigLoaderDeps,
): Promise<PipelineConfig> {
  const raw = await deps.configStore.readText('profile.json');
  if (raw === undefined) {
    throw new Error(
      `profiles/${profileName}/profile.json not found (no config_docs row, no legacy file)`,
    );
  }
  return PipelineConfigSchema.parse(JSON.parse(raw));
}

/** Reads + validates `filter.json`. The doc/file is optional (missing ⇒
 * `undefined`); present-but-invalid still throws — this isn't a doctor
 * check, so it never soft-fails. */
export async function loadFilterConfig(
  _profileName: string,
  deps: ConfigLoaderDeps,
): Promise<FilterConfig | undefined> {
  const raw = await deps.configStore.readText('filter.json');
  if (raw === undefined) return undefined;
  return FilterConfigSchema.parse(JSON.parse(raw));
}
