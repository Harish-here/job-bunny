import type { Connector } from '../../ports/index.ts';
import type { StageContext, StageDef, StagePayload } from '../runner/stage.ts';

/**
 * Sync stage (P7 Task 5) — thin `StageDef` wrapper over
 * `Connector.syncJobs`: the last job-flow stage, writing every surviving,
 * ranked job to the connector DB (automated fields only, insert-or-update —
 * see `adapters/db/notion/sync.ts`'s header for the full contract this
 * stage delegates to). A per-page write failure is already a `SoftError`
 * caught and logged *inside* the connector (it drops that one job from its
 * returned `SyncedJD[]` and continues the batch) — this wrapper does not
 * re-catch or re-wrap anything; a rejection that reaches this stage is by
 * construction NOT a per-page casualty (auth/config/other non-retryable
 * failure) and must fail the whole stage loudly, same as everywhere else.
 *
 * `Connector` is injected via a factory (`makeSyncStage`), the same pattern
 * `reconcile.ts` uses (see its header) — `StageDef.run`'s `ctx: StageContext`
 * carries no `ports`.
 *
 * `retries: 1` (vs. `0` for the other tail stages): per the plan
 * (`StageDef.retries`'s own doc comment — "0 for most; structure/sync
 * 1–2"), sync is one of the two stages the runner is allowed to
 * whole-stage-retry. A retried sync re-runs `syncJobs` over the SAME
 * payload; `syncJobs`'s per-job insert/update is naturally idempotent on a
 * retry (an already-created job on the previous attempt still lacks
 * `sync.pageId` on the payload passed in here — the connector doesn't
 * persist that back onto the retry's input — so a retry may create a
 * duplicate Notion page for a job whose first attempt actually succeeded
 * but whose *stage* failed for an unrelated reason after that write; this
 * matches v0's own at-least-once sync semantics, not a new risk introduced
 * here).
 */
export function makeSyncStage(
  connector: Connector,
): StageDef<StagePayload, StagePayload> {
  return {
    name: 'sync',
    timeoutMs: 180_000,
    retries: 1,
    async run(input: StagePayload, ctx: StageContext): Promise<StagePayload> {
      const synced = await connector.syncJobs(input.jobs, ctx);
      return { jobs: synced, dropped: input.dropped };
    },
  };
}
