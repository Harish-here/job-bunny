import type { ZodType } from 'zod';

/**
 * Filesystem-only I/O — after the checkpoints (Phase 2) and pipeline-state
 * (Phase 3) moves to sqlite, this port has exactly two remaining
 * consumers: (1) the LinkedIn lane's page-inventory reads
 * (`adapters/lanes/linkedin/inventory.ts` — `readJson` only, repo-root-
 * relative, machine-shared, never per-profile state), and (2) `routine
 * cleanup`'s legacy `profiles/<name>/data/runs/<date>/` folder pruning
 * (`listSubdirs`/`removeTree` only — a one-time cleanup of pre-Phase-2 run
 * folders on disk; the folders themselves are never written again).
 * `writeJson` has no remaining production caller. Everything that used to
 * be "run-state I/O (checkpoints, registry, caches)" now lives behind
 * `CheckpointStore`/`StateStore`.
 */
export interface Storage {
  /** undefined when the file does not exist; throws on schema mismatch. */
  readJson<T>(relPath: string, schema: ZodType<T>): Promise<T | undefined>;
  writeJson(relPath: string, value: unknown): Promise<void>;
  /** Names of the immediate subdirectories of `relPath`; `[]` when the path
   * doesn't exist. */
  listSubdirs(relPath: string): Promise<string[]>;
  /** Recursively deletes `relPath`; a no-op when it's already absent. */
  removeTree(relPath: string): Promise<void>;
}
