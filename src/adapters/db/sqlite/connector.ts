/**
 * SqliteConnector — the local-first `Connector` (local-DB spec §4).
 * The profile's own SQLite file IS the source of truth: rebuildCache
 * reads it, syncJobs upserts into it, archiveStale soft-flags rows.
 * Settings validated at construction (wire-time fail-loud, mirrors
 * NotionConnector); the DB handle opens lazily on first use so
 * constructing for doctor/wiring does zero IO.
 * Deviation from the Notion adapter, deliberate: syncJobs is
 * all-or-nothing (one transaction) — a local write failure is a
 * disk/config problem and throws loud; there is no per-row network
 * flakiness to fail soft on, so `dropped` is always [].
 */
import { z } from 'zod';
import type { DroppedRecord, JD, SyncedJD } from '../../../core/jd/index.ts';
import { PASSED_STATUS } from '../../../core/tracking/index.ts';
import type { ArchivePolicy, CacheEntry, Connector } from '../../../ports/connector.ts';
import type { RunContext } from '../../../ports/context.ts';
import { openJobsDb, SqliteStore } from './store/index.ts';

export const SqliteConnectorSettingsSchema = z.object({
  /** Archive dry-run default ON — parity with NotionConnector. */
  dryRun: z.boolean().default(true),
});

export type SqliteConnectorSettings = z.infer<typeof SqliteConnectorSettingsSchema>;

const DAY_MS = 86_400_000;

export function isStale(
  candidate: { dateFound: string; status: string | null },
  policy: ArchivePolicy,
  nowMs: number,
): boolean {
  const ageDays = (nowMs - Date.parse(candidate.dateFound)) / DAY_MS;
  if (candidate.status === PASSED_STATUS) return ageDays > policy.passedOlderThanDays;
  if (!candidate.status) return ageDays > policy.untouchedOlderThanDays;
  return false;
}

export class SqliteConnector implements Connector {
  readonly name = 'sqlite';
  private readonly settings: SqliteConnectorSettings;
  private readonly dbPath: string;
  private readonly now: () => string;
  private store: SqliteStore | undefined;

  constructor(
    settings: unknown,
    defaultDbPath: string,
    nowFn: () => string = () => new Date().toISOString(),
  ) {
    this.settings = SqliteConnectorSettingsSchema.parse(settings ?? {});
    this.dbPath = defaultDbPath;
    this.now = nowFn;
  }

  private getStore(): SqliteStore {
    if (!this.store) this.store = new SqliteStore(openJobsDb(this.dbPath));
    return this.store;
  }

  async rebuildCache(_ctx: RunContext): Promise<CacheEntry[]> {
    return this.getStore().listCacheEntries();
  }

  async syncJobs(jobs: JD[], _ctx: RunContext): Promise<SyncedJD[]> {
    const syncedAt = this.now();
    this.getStore().upsertJobs(jobs, syncedAt);
    return jobs.map((job) => ({
      ...job,
      sync: { pageId: job.identity.id, syncedAt },
    }));
  }

  async archiveStale(
    policy: ArchivePolicy,
    ctx: RunContext,
  ): Promise<{ archived: number; dropped: DroppedRecord[] }> {
    const store = this.getStore();
    const nowIso = this.now();
    const stale = store
      .listArchiveCandidates()
      .filter((candidate) => isStale(candidate, policy, Date.parse(nowIso)));
    if (this.settings.dryRun) {
      ctx.logger.info('sqlite archive dry-run', { wouldArchive: stale.length });
      return { archived: stale.length, dropped: [] };
    }
    const archived = store.markArchived(
      stale.map((candidate) => candidate.id),
      nowIso,
    );
    return { archived, dropped: [] };
  }

  /** Releases the lazily-opened handle, if one was opened; a later call
   * reopens it on demand. No-op when nothing was ever opened. */
  close(): void {
    this.store?.close();
    this.store = undefined;
  }
}
