import type { DroppedRecord } from '../../core/jd/index.ts';
import type { Connector } from '../../ports/index.ts';
import type { PipelineCtx } from '../runner/context.ts';
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
 * `opts.dryRun` (P8 Task 7, DB-backed as of runs-observability Phase 1
 * Task 6) — when set, this stage NEVER calls `connector.syncJobs`: it
 * computes the would-write set straight off `input.jobs` and records it via
 * `ctx.runStore.recordSyncDryrun(ctx.runId, report)` instead of writing a
 * per-date `sync_dryrun.json` (that per-date-overwrite bug is what this
 * change retires), returning `input` completely unchanged (same `jobs`,
 * same `dropped` — no `sync.failed` drops, since nothing was actually
 * attempted). The report captures WHICH jobs would be written
 * (id/company/title/url/city/score/excitement, for diffing against v0's
 * `cache.json` delta which keys on title+company+city) — it is NOT the
 * exact Notion property payload; that mapping lives in
 * `adapters/db/notion/sync.ts` and is deliberately not duplicated here.
 *
 * `runStore`/`runId` are read off `ctx` (cast to the superset `PipelineCtx`)
 * rather than constructor-injected like `connector` — the one exception to
 * this file's "a stage that needs a port takes it as a factory argument"
 * convention (see `reconcile.ts`'s header): `runId` doesn't exist yet at
 * `wire()` time, when this stage is constructed — the CLI driver
 * (`cli/commands/run.ts`) opens the `runs` row and mutates `ctx.runId`
 * afterward, on the SAME long-lived `ctx` object this stage later runs
 * against. `ctx.runId === undefined` (e.g. a unit test wiring a bare
 * `StageContext`) skips the write silently — observability must never red
 * a run.
 */
export interface SyncStageOpts {
  dryRun?: boolean;
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
      if (opts.dryRun) {
        const jobs = input.jobs.map((jd) => ({
          id: jd.identity.id,
          company: jd.identity.company,
          title: jd.identity.title,
          url: jd.identity.url,
          city: jd.structured?.locations[0]?.city,
          score: jd.evaluation?.score,
          verdict: jd.evaluation?.excitement,
        }));
        const report = {
          generatedAt: new Date().toISOString(),
          profile: ctx.profile,
          count: jobs.length,
          jobs,
        };
        const runCtx = ctx as PipelineCtx;
        if (runCtx.runId !== undefined) {
          runCtx.runStore.recordSyncDryrun(runCtx.runId, report);
        }
        ctx.logger.info(
          `DRY RUN — sync stage would have written ${jobs.length} job(s) to Notion; ` +
            'recorded the would-write set to the runs store instead (no Notion writes performed)',
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
