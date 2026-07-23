import type { Connector } from '../../ports/index.ts';
import type { StageContext, StageDef, StagePayload } from '../runner/stage.ts';

/**
 * Reconcile stage (P7 Task 5 — added deliberately alongside the plan's
 * listed tail stages: dedup needs a cache, and nothing else produces one).
 * Read-only on Notion: rebuilds the local mirror from the live DB via
 * `Connector.rebuildCache` and persists it to a run-scoped storage file for
 * the `dedup` stage (later in the same run) to read back — mirrors
 * compress.ts's exported-path-constant idiom for handing a value to a later
 * stage through `ctx.storage` rather than the `StagePayload`.
 *
 * The payload itself passes through unchanged — reconcile produces a cache,
 * not jobs.
 *
 * Being read-only on Notion (spec invariant: "Notion is the source of
 * truth; cache always rebuildable; reconcile read-only on Notion"), any
 * failure here (auth, network, malformed DB) is a pipeline-ordering/config
 * problem, not a narrow casualty — it fails the stage loudly (`retries: 0`,
 * no per-page soft-fail swallowing at this layer; `Connector.rebuildCache`
 * itself has no per-row soft-fail concept, unlike `syncJobs`/`archiveStale`).
 *
 * `Connector` is injected via a factory (this module's own `makeReconcileStage`),
 * the same pattern `source.ts` uses for `ApiLane[]` and `structure.ts` uses
 * for `LlmProvider` — a `StageDef`'s `run(input, ctx: StageContext)` has no
 * `ports` on `ctx` (that only exists on the superset `PipelineCtx`), so a
 * stage that needs a port takes it as a constructor argument instead of
 * reaching into `ctx`.
 */
export const CACHE_PATH = 'cache/entries.json';

/** Generous over a personal-scale DB (hundreds, not millions, of rows) —
 * `rebuildCache` pages the whole live DB in one call; sized well above what
 * even a slow multi-page fetch should need, while still a real ceiling. */
const TIMEOUT_MS = 60_000;

export function makeReconcileStage(
  connector: Connector,
): StageDef<StagePayload, StagePayload> {
  return {
    name: 'reconcile',
    timeoutMs: TIMEOUT_MS,
    retries: 0,
    async run(input: StagePayload, ctx: StageContext): Promise<StagePayload> {
      const cache = await connector.rebuildCache(ctx);
      await ctx.storage.writeJson(CACHE_PATH, cache);
      ctx.logger.info('reconcile: cache rebuilt', { entries: cache.length });
      return input;
    },
  };
}
