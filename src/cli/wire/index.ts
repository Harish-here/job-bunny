/**
 * cli/wire/index.ts (P8, split from wire.ts) — the public surface of the
 * `cli/wire/` module. `wire()` (`compose.ts`) is the single composition
 * point permitted to import `src/adapters/**`
 * (`only-wire-imports-adapters` in `.dependency-cruiser.cjs`, with a
 * TYPE-ONLY carve-out for `registry.ts` too — see its doc comment); every
 * other file under `src/cli` reaches adapters only through what `wire()`
 * hands back. Internals (`config.ts`, `registry.ts`, `settings.ts`,
 * `builders.ts`, `compose.ts`, `daemon.ts`, `migrate.ts`) are not imported
 * directly from outside this folder — go through this file.
 */

export type { BoardWireOverrides } from './board.ts';
export { wireBoard } from './board.ts';
export type { WireConfigStoreOverrides } from './builders.ts';
export { wireConfigStore } from './builders.ts';
export type { WireOverrides, WireResult } from './compose.ts';
export { wire } from './compose.ts';
export type { ConfigLoaderDeps } from './config.ts';
export { loadFilterConfig, loadPipelineConfig } from './config.ts';
export type { DaemonWireOverrides } from './daemon.ts';
export { wireDaemonRunHistory } from './daemon.ts';
export type { MigrateWire } from './migrate.ts';
export { wireMigrate } from './migrate.ts';
export type { AdapterRegistry, CheckFactory, RuntimeDeps } from './registry.ts';
export { assembleAdapterChecks } from './registry.ts';
export type { LoggingConfig } from './settings.ts';
export {
  LoggingSettingsSchema,
  resolveInterUrlDelayRange,
  resolveInventoryMaxAgeDays,
  resolveJitterRange,
  resolveLoggingSettings,
  resolveMaxCardsPerUrl,
  resolveMaxNewPerLane,
} from './settings.ts';
