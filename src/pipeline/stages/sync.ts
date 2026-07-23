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
 */
export function makeSyncStage(
  connector: Connector,
): StageDef<StagePayload, StagePayload> {
  return {
    name: 'sync',
    timeoutMs: 180_000,
    retries: 0,
    async run(input: StagePayload, ctx: StageContext): Promise<StagePayload> {
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
