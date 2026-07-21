import type { ZodType } from 'zod';

/**
 * Run-state I/O (checkpoints, registry, caches). Paths are relative to
 * the profile's data dir; the runner (P3) provides the rooted impl.
 */
export interface Storage {
  /** undefined when the file does not exist; throws on schema mismatch. */
  readJson<T>(relPath: string, schema: ZodType<T>): Promise<T | undefined>;
  writeJson(relPath: string, value: unknown): Promise<void>;
}
