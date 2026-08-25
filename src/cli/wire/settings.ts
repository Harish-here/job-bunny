/**
 * cli/wire/settings.ts (P8, split from wire.ts) — every settings default +
 * resolver `compose.ts`'s `wire()` and `registry.ts`'s real-registry
 * factories read from `PipelineConfig.settings[name]`. PURE — no
 * `src/adapters/**` import, no IO; every resolver here is a plain function
 * of an `unknown` settings blob to a validated value or a thrown zod error.
 */
import type { RegistryPolicy } from '../../core/company/schema.ts';
import { LinkedinPacingSettingsSchema } from '../../core/config/linkedin_pacing/index.ts';
import {
  isLogLevel,
  type LoggingConfig,
  LoggingSettingsSchema,
} from '../../ops/observability/index.ts';

export type { LoggingConfig } from '../../ops/observability/index.ts';
export { LoggingSettingsSchema } from '../../ops/observability/index.ts';

// --- inventory freshness (linkedin lane doctor check) ---

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

// --- source stage defaults ---

/** `RegistryPolicy` defaults for `makeSourceStage`, overridable per-profile
 * via `settings.registry`. */
export const DEFAULT_REGISTRY_POLICY: RegistryPolicy = {
  reprobeNotFoundAfterDays: 30,
  maxProbeFailures: 3,
  staleAfterFetchFailures: 3,
};

/** `maxProbesPerRun` default for `makeSourceStage`'s `opts`, overridable
 * via `settings.source`. */
export const DEFAULT_MAX_PROBES_PER_RUN = 25;

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

// --- logging settings ---

/** Parses `settings.logging` — missing/`{}` defaults quietly to
 * `{fileLevel: 'debug', ttyLevel: 'info'}`; a present-but-invalid value
 * throws (fail loud), same posture as `LinkedinPacingSettingsSchema`. A
 * valid `envOverride` (the CLI's `JOBBUNNY_TTY_LOG_LEVEL`) replaces
 * `ttyLevel` only — per-invocation verbosity is a TTY concern, and a
 * daemon-spawned child never has a TTY to mirror to anyway. An invalid or
 * empty override is ignored quietly (operator convenience). */
export function resolveLoggingSettings(
  settings: unknown,
  envOverride?: string,
): LoggingConfig {
  const parsed = LoggingSettingsSchema.parse(settings ?? {});
  if (envOverride && isLogLevel(envOverride)) {
    return { ...parsed, ttyLevel: envOverride };
  }
  return parsed;
}
