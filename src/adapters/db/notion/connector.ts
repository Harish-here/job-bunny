/**
 * NotionConnector (P7 Task 4) — the `Connector` port (`ports/connector.ts`)
 * implementation over `cache.ts`/`sync.ts`/`archive.ts`. Settings validated
 * by a zod schema AT CONSTRUCTION (mirrors the adapter-settings pattern used
 * elsewhere in `src/adapters/` — e.g. `claude-cli/provider.ts`'s options
 * object): a bad/missing `dbId` fails loudly and immediately at wiring time,
 * not on the first call. `dryRun` defaults to `true` (v0 `cleanup.js`
 * invariant: archiving requires an explicit `--apply`/`CLEANUP_APPLY`
 * opt-in) — a `NotionConnector` built with no archive setting at all can
 * never write on its first `archiveStale` call.
 *
 * This class owns no Notion-shape logic itself — every method is a thin
 * delegation to the pure functions in `cache.ts`/`sync.ts`/`archive.ts`,
 * which is also what makes those independently unit-testable without a
 * `Connector` in the loop.
 */
import { z } from 'zod';
import type { JD, SyncedJD } from '../../../core/jd/index.ts';
import type { ArchivePolicy, CacheEntry, Connector } from '../../../ports/connector.ts';
import type { RunContext } from '../../../ports/context.ts';
import { archiveStale } from './archive.ts';
import { rebuildCache } from './cache.ts';
import type { NotionApi } from './client.ts';
import { syncJobs } from './sync.ts';

export const NotionConnectorSettingsSchema = z.object({
  dbId: z.string().min(1),
  /** Dry-run default ON — see file header. */
  dryRun: z.boolean().default(true),
});

export type NotionConnectorSettings = z.infer<typeof NotionConnectorSettingsSchema>;

export class NotionConnector implements Connector {
  readonly name = 'notion';
  private readonly settings: NotionConnectorSettings;
  private readonly api: NotionApi;

  constructor(settings: unknown, api: NotionApi) {
    this.settings = NotionConnectorSettingsSchema.parse(settings);
    this.api = api;
  }

  async rebuildCache(ctx: RunContext): Promise<CacheEntry[]> {
    return rebuildCache(this.api, this.settings.dbId, ctx);
  }

  async syncJobs(jobs: JD[], ctx: RunContext): Promise<SyncedJD[]> {
    return syncJobs(this.api, this.settings.dbId, jobs, ctx);
  }

  async archiveStale(policy: ArchivePolicy, ctx: RunContext): Promise<number> {
    return archiveStale(this.api, this.settings.dbId, policy, this.settings.dryRun, ctx);
  }
}
