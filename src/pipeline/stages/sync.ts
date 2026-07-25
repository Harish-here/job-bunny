import type { DroppedRecord } from '../../core/jd/index.ts';
import type { Connector } from '../../ports/index.ts';
import type { StageContext, StageDef, StagePayload } from '../runner/stage.ts';

/**
 * Sync stage (P7 Task 5) — thin `StageDef` wrapper over
 * `Connector.syncJobs`: the last job-flow stage, writing every surviving,
 * ranked job to the connector DB (automated fields only, insert-or-update —
 * see `adapters/db/notion/sync.ts`'s header for the full contract this
 * stage delegates to). A per-page write failure is already a `SoftError`
 * caught and logged *inside* the connector (it drops that one job from its
 * returned `SyncedJD[]` and continues the batch); this wrapper diffs
 * `input.jobs` against the returned `synced` by `identity.id` and pushes one
 * `DroppedRecord` per job the connector silently dropped, so those jobs
 * still show up in the funnel/checkpoints instead of vanishing. A rejection
 * that reaches this stage is, by construction, NOT a per-page casualty
 * (auth/config/other non-retryable failure) and must fail the whole stage
 * loudly, same as everywhere else — this wrapper does not catch or re-wrap
 * that.
 *
 * `Connector` is injected via a factory (`makeSyncStage`), the same pattern
 * `reconcile.ts` uses (see its header) — `StageDef.run`'s `ctx: StageContext`
 * carries no `ports`.
 *
 * `retries: 0` (not `1`): a whole-stage retry of `syncJobs` is unsafe until
 * `syncJobs` is retry-idempotent — a retry re-runs over the SAME payload,
 * and a job whose first attempt actually created a Notion page but whose
 * *stage* failed afterward for an unrelated reason still lacks
 * `sync.pageId` on the retried input (the connector never persists that
 * back), so a whole-stage retry can double-insert a page. Per-page failures
 * are already `SoftError`s handled inside the connector and don't need
 * stage-level retry at all.
 *
 * `opts.dryRunPath` (P8 Task 7) — when set, this stage NEVER calls
 * `connector.syncJobs`: it computes the would-write set straight off
 * `input.jobs` and writes it to `ctx.storage` at that path instead,
 * returning `input` completely unchanged (same `jobs`, same `dropped` — no
 * `sync.failed` drops, since nothing was actually attempted). The artifact
 * captures WHICH jobs would be written (id/company/title/url/city/score/
 * excitement, for diffing against v0's `cache.json` delta which keys on
 * title+company+city) — it is NOT the exact Notion property payload; that
 * mapping lives in `adapters/db/notion/sync.ts` and is deliberately not
 * duplicated here.
 */
export interface SyncStageOpts {
  dryRunPath?: string;
}

export function makeSyncStage(
  connector: Connector,
  opts: SyncStageOpts = {},
): StageDef<StagePayload, StagePayload> {
  return {
    name: 'sync',
    // 15 min (was 3 min, too tight for real write volume): `syncJobs` calls
    // the Notion client once per job, and the client itself does up to 3
    // attempts with exponential backoff PER CALL on transient failures
    // (`adapters/db/notion/client.ts`) — a batch of a few dozen jobs with a
    // handful of retried calls can legitimately take several minutes.
    // `retries` stays 0 (see note below) — only the per-attempt ceiling
    // moves, not the retry count.
    timeoutMs: 900_000,
    retries: 0,
    async run(input: StagePayload, ctx: StageContext): Promise<StagePayload> {
      if (opts.dryRunPath) {
        const jobs = input.jobs.map((jd) => ({
          id: jd.identity.id,
          company: jd.identity.company,
          title: jd.identity.title,
          url: jd.identity.url,
          city: jd.structured?.locations[0]?.city,
          score: jd.evaluation?.score,
          verdict: jd.evaluation?.excitement,
        }));
        await ctx.storage.writeJson(opts.dryRunPath, {
          generatedAt: new Date().toISOString(),
          profile: ctx.profile,
          count: jobs.length,
          jobs,
        });
        ctx.logger.info(
          `DRY RUN — sync stage would have written ${jobs.length} job(s) to Notion; ` +
            `wrote the would-write set to ${opts.dryRunPath} instead (no Notion writes performed)`,
        );
        return input;
      }

      const synced = await connector.syncJobs(input.jobs, ctx);
      const syncedIds = new Set(synced.map((jd) => jd.identity.id));
      const failedDrops: DroppedRecord[] = input.jobs
        .filter((jd) => !syncedIds.has(jd.identity.id))
        .map((jd) => ({
          jd,
          reasons: [
            {
              rule: 'sync.failed',
              severity: 'hard',
              pass: false,
              detail: `Notion page write failed after exhausted retries for "${jd.identity.title}" at ${jd.identity.company}`,
            },
          ],
        }));
      return { jobs: synced, dropped: [...input.dropped, ...failedDrops] };
    },
  };
}
