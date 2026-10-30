import type { FilterConfig } from '../../../../core/filter/config.ts';
import type { BrowserHandle } from '../../../../ports/browser.ts';
import type { RunContext } from '../../../../ports/context.ts';
import type { Inventory } from '../inventory.ts';
import type { ResumeState } from '../resume_state.ts';
import type { SearchUrlGroup } from '../search_urls.ts';
import type { UrlRunnerState } from './loop/index.ts';
import { runProbe } from './probe.ts';

export type CanaryVerdict = 'confirmed-healthy' | 'not-attempted' | 'unconfirmed';

export interface CanaryDeps {
  urls: SearchUrlGroup[];
  inventories: Inventory[];
  filterCfg: FilterConfig;
  interUrlPause: () => Promise<void>;
}

/** R6/R7's canary (spec §8 Q7): when a fire's every attempted URL this
 * cycle failed, re-probe ONE url already known-good today to tell "one/some
 * bad links" apart from a genuine session-wide outage.
 *
 * A throttle trip or ANY shell response already IS session-wide-distress
 * evidence for this very fire (`fire/loop/cards.ts:167-183` — 3 consecutive
 * shells trips the breaker; a SINGLE shell is already suspicious) —
 * probing again risks an intermittently-recovering soft-block handing back
 * one lucky `runProbe` 'ok' and greening a run that is, in fact,
 * mid-outage. Skip straight to 'unconfirmed' in either case, at zero extra
 * navigation cost, so the caller's existing loud throw stands unchanged. */
export async function runCanaryProbe(
  deps: CanaryDeps,
  resumeState: ResumeState,
  state: { throttleTripped: boolean; shellJdFailures: number },
  handle: BrowserHandle,
  ctx: RunContext,
): Promise<CanaryVerdict> {
  if (state.throttleTripped || state.shellJdFailures > 0) {
    return 'unconfirmed';
  }
  const candidateUrls = deps.urls.flatMap((g) => g.urls);
  const canaryUrl = resumeState.pickCanaryUrl(candidateUrls);
  if (!canaryUrl) return 'not-attempted';
  // Structurally guaranteed to find a group — pickCanaryUrl only ever
  // returns a member of candidateUrls — kept as a defensive `undefined`
  // fallback rather than a non-null assertion.
  const canaryGroup = deps.urls.find((g) => g.urls.includes(canaryUrl));
  if (!canaryGroup) return 'not-attempted';
  await deps.interUrlPause();
  const outcome = await runProbe(
    {
      urls: [{ page: canaryGroup.page, urls: [canaryUrl] }],
      inventories: deps.inventories,
      filterCfg: deps.filterCfg,
    },
    handle,
    ctx,
  );
  // The canary's own capture (on 'ok') is deliberately discarded — never
  // appended to captureStore, never added to processedIds, never pushed as
  // a UrlStat. This probe exists only to answer "is the session healthy",
  // not to harvest — appending it would risk a duplicate JD for zero
  // benefit.
  return outcome.result === 'ok' ? 'confirmed-healthy' : 'unconfirmed';
}

/** Everything lane.ts's source() needs after its all-attempted-failed
 * check, computed HERE (not in lane.ts) so the caller's own footprint stays
 * a single call. Reads `state.stats` directly (already a field of the
 * `UrlRunnerState` lane.ts already builds) rather than taking a separate
 * `stats` parameter. */
export interface CanaryEvaluation {
  confirmedHealthy: boolean;
  // Optional (not `| undefined`) — an optional field lets the hoisted
  // default in task 11 omit it entirely, staying on one 90-char-safe line.
  linkSoftErrors?: { url: string; reason: string }[];
}

export async function evaluateAllFailedCanary(
  state: UrlRunnerState,
  urls: SearchUrlGroup[],
  inventories: Inventory[],
  filterCfg: FilterConfig,
  interUrlPause: () => Promise<void>,
  handle: BrowserHandle,
  ctx: RunContext,
): Promise<CanaryEvaluation> {
  const attemptedUrls = state.stats.length;
  const failedUrls = state.stats.filter((s) => s.failed).length;
  if (attemptedUrls === 0 || failedUrls !== attemptedUrls) {
    return { confirmedHealthy: false };
  }
  const verdict = await runCanaryProbe(
    { urls, inventories, filterCfg, interUrlPause },
    state.resumeState,
    state,
    handle,
    ctx,
  );
  ctx.logger.warn(
    'linkedin lane: leftover links all failed this fire — ran a canary against a link already done today',
    { verdict },
  );
  if (verdict !== 'confirmed-healthy') {
    return { confirmedHealthy: false };
  }
  return {
    confirmedHealthy: true,
    linkSoftErrors: state.stats
      .filter((s) => s.failed)
      .map((s) => ({
        url: s.url,
        reason: s.failures[0]?.message ?? 'link failed this fire',
      })),
  };
}
