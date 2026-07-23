import type { CacheEntry, JD, SyncedJD } from '../core/jd/index.ts';
import type { RunContext } from './context.ts';

/** Canonical definition now lives in core/jd (a plain data shape, not port
 * behavior) — re-exported here so every existing importer keeps compiling
 * unchanged. */
export type { CacheEntry };

/** Archive policy consumed by the cleanup routine (spec §3). */
export interface ArchivePolicy {
  passedOlderThanDays: number;
  untouchedOlderThanDays: number;
}

/** External DB persisting pipeline output. The DB is the source of truth. */
export interface Connector {
  readonly name: string;
  /** Rebuild the local cache from the live DB — strictly read-only on it. */
  rebuildCache(ctx: RunContext): Promise<CacheEntry[]>;
  /** Writes automated fields only, never user-edited ones. */
  syncJobs(jobs: JD[], ctx: RunContext): Promise<SyncedJD[]>;
  /** Returns the number of records archived. */
  archiveStale(policy: ArchivePolicy, ctx: RunContext): Promise<number>;
}
