import { z } from 'zod';
import { sleep } from '../../../core/async/index.ts';
import type { FilterConfig } from '../../../core/filter/config.ts';
import { CacheEntrySchema, type DroppedRecord, type JD } from '../../../core/jd/index.ts';
import type { BrowserProvider } from '../../../ports/browser.ts';
import type { RunContext } from '../../../ports/context.ts';
import type { FarmingLane } from '../../../ports/lane.ts';
import type { Storage } from '../../../ports/storage.ts';
import type { LinkedinBreakerConfig } from './breaker_store.ts';
import { breakerPhase, readBreaker } from './breaker_store.ts';
import { CaptureStore } from './capture_store.ts';
import {
  buildAllUrlsFailedMessage,
  buildNoJdCapturedVerdict,
  todayIso,
  type UrlStat,
} from './evidence.ts';
import { runHalfOpenProbe, runUrlGroups, type UrlRunnerState } from './fire/index.ts';
import type { Inventory } from './inventory.ts';
import {
  DEFAULT_INTER_URL_DELAY_MAX_MS,
  DEFAULT_INTER_URL_DELAY_MIN_MS,
  DEFAULT_JITTER_MAX_MS,
  DEFAULT_JITTER_MIN_MS,
  jitterMs,
} from './pacing/index.ts';
import { ResumeState } from './resume_state.ts';
import type { SearchUrlGroup } from './search_urls.ts';
import { THROTTLE_COOLDOWN_MS, ThrottleCounter } from './throttle.ts';

/**
 * Path of the reconciled Notion cache, read here for the lane's own
 * cache-skip gate. Deliberately duplicated from
 * `pipeline/stages/reconcile.ts`'s `CACHE_PATH` rather than imported —
 * adapters may only import ports + core (`.dependency-cruiser.cjs`
 * `adapters-only-ports-core`), never `pipeline/**`. Same posture as
 * `adapters/lanes/greenhouse/api.ts` duplicating `htmlToText` rather than
 * cross-importing the Keka lane. Both this lane's `this.storage` and the
 * reconcile stage's `ctx.storage` are the same profile-rooted handle, so
 * the relative path must stay byte-identical to reconcile.ts's constant.
 */
const CACHE_ENTRIES_PATH = 'cache/entries.json';
const CacheEntriesSchema = z.array(CacheEntrySchema);

/** Default per-URL cap on how many gate-passed, not-cached, not-already-
 * processed-this-run cards get an expensive JD open. A backstop, not the
 * primary volume control (that's the card gate) — v0 had no LinkedIn
 * equivalent of GH_MAX_NEW/KEKA_MAX_NEW, so this default is chosen to sit
 * in the same range as the ATS lanes' cap (40) rather than ported from a
 * v0 constant. */
const DEFAULT_MAX_CARDS_PER_URL = 40;

/**
 * LinkedIn farming lane (P4 Task 7): composes inventory + harvest/gate +
 * jd_open + resume_state into a FarmingLane. Owns fail-soft granularity
 * (spec §7): one URL group with no matching inventory, one URL whose
 * newPage/goto/harvest fails, or one card whose JD open fails are each
 * logged and the lane continues past them — but if EVERY attempted URL
 * fails, that's not "one flaky selector", it's shaped like an expired
 * LinkedIn session (logout wall), so source() throws loud in that case
 * (mirrors v0 extract.js's checkAggregateFailure). The lane's OWN failure
 * (browser.launch rejecting, e.g. Chrome won't launch) is always thrown
 * loud out of source().
 */
export class LinkedInLane implements FarmingLane {
  readonly kind = 'farming' as const;
  readonly name = 'linkedin';

  private readonly browser: BrowserProvider;
  private readonly inventories: Inventory[];
  private readonly urls: SearchUrlGroup[];
  private readonly filterCfg: FilterConfig;
  private readonly storage: Storage;
  private readonly maxCardsPerUrl: number;
  private readonly jitterMinMs: number;
  private readonly jitterMaxMs: number;
  private readonly randomFn: () => number;
  private readonly sleepFn: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly interUrlDelayMinMs: number;
  private readonly interUrlDelayMaxMs: number;
  private readonly breaker: LinkedinBreakerConfig | undefined;

  constructor(
    browser: BrowserProvider,
    inventories: Inventory[],
    urls: SearchUrlGroup[],
    filterCfg: FilterConfig,
    storage: Storage,
    maxCardsPerUrl: number = DEFAULT_MAX_CARDS_PER_URL,
    jitterMinMs: number = DEFAULT_JITTER_MIN_MS,
    jitterMaxMs: number = DEFAULT_JITTER_MAX_MS,
    // Injectable RNG (v0 parity, jitterMs's own `rand` param) and sleep
    // (real default: core/async's abort-aware sleep) — tests inject both
    // so no test suite run ever really waits seconds (see lane.test.ts).
    randomFn: () => number = Math.random,
    sleepFn: (ms: number, signal: AbortSignal) => Promise<void> = sleep,
    // Appended after sleepFn (rather than beside the jitter pair) so every
    // existing positional call site — this file's whole test suite —
    // compiles unchanged.
    interUrlDelayMinMs: number = DEFAULT_INTER_URL_DELAY_MIN_MS,
    interUrlDelayMaxMs: number = DEFAULT_INTER_URL_DELAY_MAX_MS,
    breaker?: LinkedinBreakerConfig,
  ) {
    this.browser = browser;
    this.inventories = inventories;
    this.urls = urls;
    this.filterCfg = filterCfg;
    this.storage = storage;
    this.maxCardsPerUrl = maxCardsPerUrl;
    this.jitterMinMs = jitterMinMs;
    this.jitterMaxMs = jitterMaxMs;
    this.randomFn = randomFn;
    this.sleepFn = sleepFn;
    this.interUrlDelayMinMs = interUrlDelayMinMs;
    this.interUrlDelayMaxMs = interUrlDelayMaxMs;
    this.breaker = breaker;
  }

  /** Randomized inter-request pacing (v0 parity — see DEFAULT_JITTER_MIN_MS
   * doc comment). Abort-aware (`ctx.signal`) so a cancelled run never sits
   * in this sleep; a zero-length range (jitterMinMs === jitterMaxMs === 0,
   * e.g. a test) is a no-op rather than a wasted timer tick. */
  private async jitter(ctx: RunContext): Promise<void> {
    const ms = jitterMs(this.jitterMinMs, this.jitterMaxMs, this.randomFn);
    if (ms <= 0) return;
    await this.sleepFn(ms, ctx.signal);
  }

  /** Randomized pause between saved-search urls (D2). Distinct from
   * `jitter`, which paces individual navigations inside one url: this is
   * the gap that stops 21 saved searches from arriving as one burst, the
   * pattern that most likely provoked the 2026-07-28 soft block. Shares
   * `jitterMs` + `sleepFn` + `randomFn` with jitter, so it is abort-aware
   * for free and a zero-length range is a no-op. */
  private async interUrlPause(ctx: RunContext): Promise<void> {
    const ms = jitterMs(this.interUrlDelayMinMs, this.interUrlDelayMaxMs, this.randomFn);
    if (ms <= 0) return;
    await this.sleepFn(ms, ctx.signal);
  }

  async source(ctx: RunContext): Promise<{
    jobs: JD[];
    dropped: DroppedRecord[];
    companiesSeen: string[];
    skipped?: { reason: string };
  }> {
    // Breaker read comes before ANY other work (spec §4.5 step 1): an open
    // breaker must leave zero footprint on the blocked session, and
    // LinkedIn is the only browser lane in farm, so this is also what stops
    // Chrome from being launched at all.
    const breakerState = this.breaker
      ? readBreaker(this.breaker.userDataDir, this.breaker.deps, (detail) =>
          // Corrupt state reads as `closed`, i.e. this fire farms with no
          // guard at all (D12, spec §5 row 1). That is the right failure
          // direction but it must not be silent: without this line the
          // only symptom is a breaker that mysteriously never fires.
          ctx.logger.warn(
            'linkedin lane: breaker state unreadable — throttle guard disabled this fire',
            { detail },
          ),
        )
      : undefined;
    const phase = this.breaker
      ? breakerPhase(breakerState, this.breaker.deps.now(), THROTTLE_COOLDOWN_MS)
      : 'closed';

    if (phase === 'open' && breakerState) {
      const reopenAt = new Date(
        Date.parse(breakerState.openedAt) + THROTTLE_COOLDOWN_MS,
      ).toISOString();
      ctx.logger.warn(
        'linkedin lane: throttle breaker is open — skipping this fire without launching a browser',
        { reopenAt, tripCount: breakerState.tripCount },
      );
      return {
        jobs: [],
        dropped: [],
        companiesSeen: [],
        skipped: { reason: `throttle cooldown until ${reopenAt}` },
      };
    }

    const resumeState = await ResumeState.load(this.storage, todayIso());
    const captureStore = await CaptureStore.load(this.storage);

    // Cache-skip gate (P9 closure register §1, Task B): a card already
    // known to the reconciled Notion cache never gets an expensive JD
    // open. Read once per run, not per url — fail-soft on a missing/
    // unreadable cache (e.g. this lane run standalone without a
    // preceding reconcile) rather than throwing, same posture as
    // `pipeline/stages/source.ts`'s cache gate.
    let cacheIds: Set<string>;
    try {
      const entries = await this.storage.readJson(CACHE_ENTRIES_PATH, CacheEntriesSchema);
      if (entries === undefined) {
        ctx.logger.warn(
          'linkedin lane: no Notion cache found — cache gate disabled, known jobs may reach the LLM stage',
          { path: CACHE_ENTRIES_PATH },
        );
        cacheIds = new Set();
      } else {
        cacheIds = new Set(entries.map((e) => e.id).filter(Boolean));
      }
    } catch (err) {
      ctx.logger.warn(
        'linkedin lane: failed to read Notion cache — cache gate disabled',
        {
          path: CACHE_ENTRIES_PATH,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      cacheIds = new Set();
    }

    // Cross-URL run-dedup (Task B): the same job id showing up under two
    // different search URLs within this one run must only ever be
    // processed (JD-opened) once. Scoped to the whole source() call, not
    // per url.
    const processedIds = new Set<string>();

    // Multi-fire same-day schedules: if every url across all groups was
    // already captured by an earlier fire today, a later fire should
    // rescan everything rather than skip every url and return nothing.
    // (An empty url list is vacuously "all done" — rescanReset() on an
    // already-empty done-map is a harmless no-op, and the loop below does
    // nothing either way.) A partial done-set (some, not all, urls done)
    // leaves the done-map intact so this run still skips what it already
    // finished. CaptureStore is reset in lockstep — the captures behind
    // the done-map being cleared must go with it (see capture_store.ts).
    const allUrls = this.urls.flatMap((group) => group.urls);
    if (resumeState.allDone(allUrls)) {
      resumeState.rescanReset();
      await captureStore.reset(this.storage);
    }

    const dropped: DroppedRecord[] = [];
    const companiesSeen = new Set<string>();

    // One UrlStat per attempted url — everything the post-loop guards and
    // observability need (aggregate-failure detection, the lane-wide
    // "no JD ever opened" guard that caught the 2026-07-25 incident, the
    // per-kind failure evidence, extraction-source counts) is derived
    // from these records after the loop instead of being tracked in
    // parallel scalar counters.
    const stats: UrlStat[] = [];

    // Only armed when a breaker is configured: with no breaker there is
    // nothing to open, so the classification's extra page.evaluate per
    // failed JD would be pure cost. This is also what keeps every
    // pre-throttle-guard call site (and its tests) behaviorally identical.
    const throttle = this.breaker ? new ThrottleCounter() : undefined;

    // Lane's own failure (Chrome won't launch) is loud — deliberately NOT
    // caught here.
    const handle = await this.browser.launch(ctx);

    // Everything the url_runner loop reads/mutates for this run, kept in
    // one place so the aggregates below (computed after handle.close())
    // can still see it — object fields, unlike a bare `let`, stay visible
    // across the runUrlGroups() call boundary.
    const state: UrlRunnerState = {
      stats,
      dropped,
      companiesSeen,
      captureStore,
      resumeState,
      throttle,
      processedIds,
      attemptedAnyUrl: false,
      throttleTripped: false,
      shellJdFailures: 0,
    };

    try {
      if (phase === 'half-open' && this.breaker && breakerState) {
        // Orchestrates the whole D8 probe (run it, then act on its
        // verdict — re-open/leave-open/close the breaker) in one call;
        // see `fire/probe.ts`'s `runHalfOpenProbe` for the step-by-step
        // reasoning this used to carry inline here.
        const probeResult = await runHalfOpenProbe(
          this.breaker,
          breakerState,
          { urls: this.urls, inventories: this.inventories, filterCfg: this.filterCfg },
          handle,
          { captureStore, storage: this.storage, processedIds, stats },
          ctx,
        );
        if (probeResult.skipped) {
          return {
            jobs: [],
            dropped: [],
            companiesSeen: [],
            skipped: probeResult.skipped,
          };
        }
        // The probe just navigated and JD-opened against the very url the
        // main loop is about to request again (that re-navigation is by
        // design — the probe reads one card, the loop reads the rest).
        // Marking the fire as having attempted a url makes the loop pace
        // that repeat like any other — otherwise recovery, the moment
        // LinkedIn is most watchful, would open the same url twice
        // back-to-back with no gap at all.
        state.attemptedAnyUrl = true;
      }

      await runUrlGroups(
        this.urls,
        state,
        {
          browserHandle: handle,
          inventories: this.inventories,
          filterCfg: this.filterCfg,
          storage: this.storage,
          maxCardsPerUrl: this.maxCardsPerUrl,
          jitter: (c) => this.jitter(c),
          interUrlPause: (c) => this.interUrlPause(c),
          cacheIds,
          breaker: this.breaker,
          breakerState,
        },
        ctx,
      );
    } finally {
      await handle.close();
    }

    // Everything below is derived from the per-url stats gathered above.
    const attemptedUrls = stats.length;
    const failedUrls = stats.filter((s) => s.failed).length;
    // Summed across every url, independent of per-url pass/fail — the
    // lane-wide guard further down fires on these aggregates even when no
    // single url is "the" failed one (2026-07-25 incident: url A attempted
    // 2 cards and failed both, url B attempted 0, so failedUrls (1) !==
    // attemptedUrls (2) kept the all-urls-failed check quiet).
    const totalCardsAttempted = stats.reduce((n, s) => n + s.cardsAttempted, 0);
    const totalCaptured = stats.reduce((n, s) => n + s.captured, 0);
    const anchorExtractions = stats.reduce((n, s) => n + s.anchorExtractions, 0);

    // The anchor fallback carrying captures means the configured jdRoot
    // selector is not matching — the run still succeeds, but silently
    // depending on the last-resort path is one copy/locale drift away
    // from a total outage. Surface it every run until the inventory is
    // regenerated.
    if (anchorExtractions > 0) {
      ctx.logger.warn(
        'linkedin lane: JD text came from the anchor-text fallback, not the configured jdRoot selector — regenerate the page inventory (/page-analyse)',
        { anchorExtractions, totalCaptured },
      );
    }

    // Every attempted url failed: this is not one broken selector — fail
    // loud rather than a silently-green zero-job run (v0
    // checkAggregateFailure). It is NOT always an expired session, though
    // (2026-07-25: a healthy session failed this guard because card
    // title/company selectors had drifted, not because of a logout wall —
    // see memory/extract-flaky root-cause notes). buildAllUrlsFailedMessage
    // reports the observed evidence and lets it point at distinct
    // candidate causes instead of asserting one guessed cause.
    if (attemptedUrls > 0 && failedUrls === attemptedUrls) {
      throw new Error(
        buildAllUrlsFailedMessage(attemptedUrls, stats, state.shellJdFailures),
      );
    }

    // Lane-wide "no JD ever opened" guard: reached only when the
    // all-urls-failed check above did NOT already throw with its
    // detailed evidence, i.e. not every url was marked failed — e.g. one
    // url attempts and fails cards while another has nothing survive
    // title-gating, so cardsAttempted === 0 for it and it never counts
    // toward failedUrls. A 100% JD-open failure rate across the whole
    // lane is still a real outage even then, not a clean run. Fires only
    // when cards WERE attempted somewhere — a run where every url's
    // cards were legitimately title-gated away (totalCardsAttempted ===
    // 0) is an empty result, not an outage, and must not throw here.
    // Throwing is the discard-everything channel, though: the lane's
    // return value is captureStore.all(), which a resumed/second same-day
    // fire seeds with the EARLIER fire's persisted captures — so when
    // real captured work coexists with this fire's outage, the outage is
    // logged loudly and the preserved JDs are returned instead of thrown
    // away (review finding 4).
    if (totalCardsAttempted > 0 && totalCaptured === 0) {
      const priorCaptures = captureStore.all().length;
      const verdict = buildNoJdCapturedVerdict(
        totalCardsAttempted,
        attemptedUrls,
        priorCaptures,
      );
      if (verdict.shouldThrow) {
        throw new Error(verdict.message);
      }
      ctx.logger.warn(verdict.message, {
        totalCardsAttempted,
        attemptedUrls,
        priorCaptures,
      });
    }

    return { jobs: captureStore.all(), dropped, companiesSeen: [...companiesSeen] };
  }
}
