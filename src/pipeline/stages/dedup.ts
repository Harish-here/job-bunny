import { z } from 'zod';
import { dedupe } from '../../core/dedup/index.ts';
import { CacheEntrySchema } from '../../core/jd/index.ts';
import type { StageContext, StageDef, StagePayload } from '../runner/stage.ts';
import { CACHE_PATH } from './reconcile.ts';

/**
 * Dedup stage (P7 Task 5) — thin `StageDef` wrapper over the pure
 * `core/dedup`'s `dedupe(jobs, cache)`. The cache it dedupes against is not
 * carried on the `StagePayload` (spec keeps `StagePayload` frozen to
 * `{ jobs, dropped }`) — it is the `CacheEntry[]` the `reconcile` pre-stage
 * wrote to `ctx.storage` this same run (`reconcile.ts`'s `CACHE_PATH`),
 * read back here and zod-validated on ingress (`assemble.ts`'s idiom for
 * trusting nothing that crossed a storage boundary, even one this run
 * itself wrote earlier).
 *
 * A missing cache file is a pipeline-ordering bug (dedup run without a
 * preceding reconcile in the same run), not "no known jobs yet" — silently
 * treating it as an empty cache would let every job in the run sail through
 * dedup unchecked against Notion, which is worse than failing loudly and
 * immediately (mirrors compress.ts's reasoning for a job missing
 * `content.rawText`: an ordering bug should fail loud, not be "helpfully"
 * absorbed as an empty/neutral value). `dedupe` itself never sees an empty
 * cache stand in for a real one — it errors out before that call.
 *
 * No injected dependency here (unlike filter/rank's `FilterConfig`/
 * `RankConfig`, or reconcile/sync's `Connector`) — `dedupe` is pure and
 * needs nothing but the payload and the storage-carried cache — so this is
 * a plain exported `StageDef`, matching `assemble.ts`'s (also
 * dependency-free) plain-const pattern rather than a `make*Stage` factory.
 */
const CacheSchema = z.array(CacheEntrySchema);

export const dedupStage: StageDef<StagePayload, StagePayload> = {
  name: 'dedup',
  timeoutMs: 30_000,
  retries: 0,
  async run(input: StagePayload, ctx: StageContext): Promise<StagePayload> {
    const cache = await ctx.storage.readJson(CACHE_PATH, CacheSchema);
    if (cache === undefined) {
      throw new Error(
        `dedup: no cache found at ${CACHE_PATH} — dedup must run after reconcile`,
      );
    }

    const result = dedupe(input.jobs, cache);
    return { jobs: result.jobs, dropped: [...input.dropped, ...result.dropped] };
  },
};
