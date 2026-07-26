import type { ZodType } from 'zod';

/**
 * Run-state I/O (checkpoints, registry, caches). Paths are relative to
 * the profile's data dir; the runner (P3) provides the rooted impl.
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
