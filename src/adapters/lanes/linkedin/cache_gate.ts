import { z } from 'zod';
import { CacheEntrySchema } from '../../../core/jd/index.ts';
import type { RunContext } from '../../../ports/context.ts';
import type { StateStore } from '../../../ports/state_store.ts';

/** Path of the reconciled Notion cache, read here for the lane's own
 * cache-skip gate (split out of `lane.ts`, Phase 3, purely to keep that
 * file under its line cap — same posture as `harvest.ts`'s `card_gate.ts`
 * split). Deliberately duplicated from `pipeline/stages/reconcile.ts`'s
 * `CACHE_PATH` rather than imported — adapters may only import ports +
 * core (`adapters-only-ports-core`), never `pipeline/**`, same posture as
 * `greenhouse/api.ts` duplicating `htmlToText` rather than cross-importing
 * Keka. Must stay byte-identical to reconcile.ts's constant: this lane's
 * `this.stateStore` and the reconcile stage's `ctx.stateStore` share the
 * same `jobbunny.db` state_docs row via this key.
 */
export const CACHE_ENTRIES_PATH = 'cache/entries.json';
const CacheEntriesSchema = z.array(CacheEntrySchema);

/** Cache-skip gate (P9 closure register §1, Task B): a card already known
 * to the reconciled Notion cache never gets an expensive JD open. Read
 * once per run, not per url — fail-soft on a missing/unreadable cache
 * (e.g. this lane run standalone without a preceding reconcile) rather
 * than throwing, same posture as `pipeline/stages/source.ts`'s cache gate. */
export async function loadCacheIds(
  stateStore: StateStore,
  ctx: RunContext,
): Promise<Set<string>> {
  try {
    const entries = await stateStore.readDoc(CACHE_ENTRIES_PATH, CacheEntriesSchema);
    if (entries === undefined) {
      ctx.logger.warn(
        'linkedin lane: no Notion cache found — cache gate disabled, known jobs may reach the LLM stage',
        { path: CACHE_ENTRIES_PATH },
      );
      return new Set();
    }
    return new Set(entries.map((e) => e.id).filter(Boolean));
  } catch (err) {
    ctx.logger.warn('linkedin lane: failed to read Notion cache — cache gate disabled', {
      path: CACHE_ENTRIES_PATH,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Set();
  }
}
