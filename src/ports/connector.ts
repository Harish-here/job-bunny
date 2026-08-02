import type { CacheEntry, DroppedRecord, JD, SyncedJD } from '../core/jd/index.ts';
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
  /** Returns the number of records archived, plus every page that failed
   * to archive (a per-page SoftError, retries exhausted) as a
   * DroppedRecord — same funnel-visibility contract as `syncJobs`'s
   * caller-side diff in `pipeline/stages/sync.ts` — so a caller can
   * account for it instead of it only reaching a warn log line. */
  archiveStale(
    policy: ArchivePolicy,
    ctx: RunContext,
  ): Promise<{ archived: number; dropped: DroppedRecord[] }>;
  /**
   * Optional: release any held resources (open DB handles). Absent on
   * connectors with nothing to release; callers must tolerate absence.
   * Never called by the pipeline runner (process exit releases handles) —
   * exists for embedders and tests, where Windows cannot delete an
   * sqlite file whose handle is still open.
   */
  close?(): void;
}
