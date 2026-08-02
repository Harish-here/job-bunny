import { z } from 'zod';
import type { FilterConfig } from '../../../../../core/filter/config.ts';
import type { DroppedRecord } from '../../../../../core/jd/index.ts';
import type { BrowserHandle, PageHandle } from '../../../../../ports/browser.ts';
import type { RunContext } from '../../../../../ports/context.ts';
import type { Storage } from '../../../../../ports/storage.ts';
import type { LinkedinBreakerConfig, LinkedinBreakerState } from '../../breaker_store.ts';
import type { CaptureStore } from '../../capture_store.ts';
import { toSoftError, type UrlStat, zodIssuesMessage } from '../../evidence.ts';
import { gateCards, type HarvestedCard, harvestCards } from '../../harvest.ts';
import type { Inventory } from '../../inventory.ts';
import { buildPageUrl, resolvePagination, sameCardIdSet } from '../../pacing/index.ts';
import type { ResumeState } from '../../resume_state.ts';
import type { SearchUrlGroup } from '../../search_urls.ts';
import type { ThrottleCounter } from '../../throttle.ts';
import { type CardLoopState, processCard } from './cards.ts';

/** Own copy of the goto deadline — see `probe.ts`'s identical constant and
 * its doc comment for why it is duplicated rather than cross-imported. */
const DEFAULT_GOTO_TIMEOUT_MS = 30_000;

/** Mutated in place by `runUrlGroups` — the collected-so-far record for one
 * `source()` run. Callers (`lane.ts`) read the same object back after the
 * call to compute aggregates/evidence, since object fields (unlike a bare
 * `let`) stay visible across the function-call boundary. */
export interface UrlRunnerState {
  stats: UrlStat[];
  dropped: DroppedRecord[];
  companiesSeen: Set<string>;
  captureStore: CaptureStore;
  resumeState: ResumeState;
  throttle: ThrottleCounter | undefined;
  /** Cross-URL run-dedup (Task B): the same job id showing up under two
   * different search URLs within this one run must only ever be
   * processed (JD-opened) once. Scoped to the whole source() call, not
   * per url. */
  processedIds: Set<string>;
  attemptedAnyUrl: boolean;
  throttleTripped: boolean;
  /** Shells seen this run, for the all-urls-failed evidence (D13). */
  shellJdFailures: number;
}

/** Read-only inputs `runUrlGroups` needs — the lane fields it reads
 * (inventories, filterCfg), the pacing functions, the cache set, and the
 * per-url cap, plus the already-launched browser handle. */
export interface UrlRunnerDeps {
  browserHandle: BrowserHandle;
  inventories: Inventory[];
  filterCfg: FilterConfig;
  storage: Storage;
  maxCardsPerUrl: number;
  jitter: (ctx: RunContext) => Promise<void>;
  interUrlPause: (ctx: RunContext) => Promise<void>;
  cacheIds: Set<string>;
  breaker: LinkedinBreakerConfig | undefined;
  breakerState: LinkedinBreakerState | undefined;
}

/**
 * The per-group/per-URL/per-page loop (spec §7 fail-soft granularity) —
 * extracted verbatim off `lane.ts`'s `source()`, with the per-card body
 * further split into `cards.ts`'s `processCard`. Mutates `state` in
 * place; returns nothing (all its outputs — stats, dropped,
 * companiesSeen, capture/resume persistence, throttle/breaker phase data
 * — live on `state`, which the caller already holds a reference to).
 */
export async function runUrlGroups(
  urls: SearchUrlGroup[],
  state: UrlRunnerState,
  deps: UrlRunnerDeps,
  ctx: RunContext,
): Promise<void> {
  for (const group of urls) {
    const inv = deps.inventories.find((candidate) => candidate.page === group.page);
    if (!inv) {
      ctx.logger.warn('linkedin lane: no inventory found for page', {
        page: group.page,
      });
      continue;
    }

    // Pagination behaviors are per-inventory (per page group), not
    // per-url — resolved once per group rather than re-parsed for
    // every url in it.
    const pagination = resolvePagination(inv, ctx);

    for (const url of group.urls) {
      if (state.resumeState.shouldSkip(url)) {
        ctx.logger.info('linkedin lane: skipping already-done url', { url });
        continue;
      }

      // Placed AFTER the skip check on purpose: a url this fire never
      // touches must not cost 20-45s of wall clock. Deliberately outside
      // the per-url try/catch below — the only way sleepFn rejects is an
      // aborted ctx.signal, which must propagate loud (the run is over),
      // not be recorded as this url's SoftError.
      if (state.attemptedAnyUrl) await deps.interUrlPause(ctx);
      state.attemptedAnyUrl = true;

      const stat: UrlStat = {
        url,
        cardsAttempted: 0,
        captured: 0,
        anchorExtractions: 0,
        failed: false,
        failures: [],
      };
      state.stats.push(stat);
      let page: PageHandle | undefined;
      try {
        // newPage() lives INSIDE this try: a dead CDP context (e.g.
        // LinkedIn killing a tab) is this url's failure alone, not a
        // whole-lane crash.
        page = await deps.browserHandle.newPage();

        // capLoop/previousCardIds are per-URL, accumulated across that
        // url's pages (not reset per page).
        const capLoop: CardLoopState = { capLogged: false };
        let previousCardIds: Set<string> | null = null;

        for (let pageIndex = 1; pageIndex <= pagination.maxPages; pageIndex++) {
          const pageUrl = buildPageUrl(
            url,
            pageIndex,
            pagination.param,
            pagination.pageSize,
          );

          let cards: HarvestedCard[];
          try {
            await page.goto(pageUrl, { timeoutMs: DEFAULT_GOTO_TIMEOUT_MS });
            // v0 parity placement: jitter comes AFTER goto, BEFORE the
            // page is read (scripts/pipeline/extract/cards.js:187/:204 —
            // `await gotoWithRetry(...); await jitterFn();`, immediately
            // preceding runAssertions/collectCards, harvestCards' v2
            // counterpart). Applied per page, not just once per url.
            await deps.jitter(ctx);
            // Page 1 keeps harvestCards' strict emptiness assertions —
            // DOM drift there must stay loud. Page N>=2 tolerates a
            // genuinely empty page (allowEmpty): end-of-results looks
            // exactly like an empty page, and that's normal, not a
            // failure — the `stop` check below is what should end
            // pagination for it, not a thrown SoftError.
            cards = await harvestCards(page, inv, ctx, {
              allowEmpty: pageIndex >= 2,
            });
          } catch (err) {
            // Page 1's navigation/harvest failure keeps its existing
            // whole-url semantics (rethrow into the outer catch below,
            // unchanged classification/evidence, unchanged not-done
            // resume state). Page N>=2 is a narrower casualty — this
            // url already has real captures from earlier pages, so
            // record a SoftError and stop paginating rather than
            // failing the whole url retroactively.
            if (pageIndex === 1) throw err;
            const soft = toSoftError('url', pageUrl, err);
            ctx.logger.warn(
              'linkedin lane: pagination page failed — stopping pagination for this url, keeping earlier captures',
              { url, page: pageIndex, message: soft.message },
            );
            break;
          }

          // Page-level heartbeat: this page's goto/harvest already
          // constitutes real progress regardless of what gateCards
          // decides next — a run of many consecutive zero-gate pages
          // (e.g. filters matching almost nothing) is genuinely alive
          // work, not a stall, and must not starve the watchdog of
          // ticks the way per-card-only beats (cards.ts' processCard)
          // would when `pass` ends up empty.
          ctx.beat();

          const {
            pass,
            dropped: gateDropped,
            identityInvalidCount,
          } = gateCards(cards, deps.filterCfg);
          state.dropped.push(...gateDropped);

          // Total-outage guard (2026-08-02 review, restored): one
          // unsettled card is a narrow casualty (gateCards' own doc
          // comment) — but a page where EVERY harvested card came back
          // identity-invalid looks like the same systemic paint-storm/
          // selector-drift the pre-fix crash used to (accidentally)
          // surface as a loud url failure, and must still drive
          // lane.ts's failedUrls===attemptedUrls guard and
          // evidence.ts's field-validation evidence branch. Recorded
          // directly rather than by throwing — a thrown ZodError here
          // would just be the discarded-page bug this module now fixes,
          // reintroduced — and pagination stops for this url, mirroring
          // what the old uncaught throw did.
          if (cards.length > 0 && identityInvalidCount === cards.length) {
            stat.failed = true;
            const message =
              `${identityInvalidCount} of ${cards.length} harvested card(s) on ` +
              `"${inv.page}" had empty/invalid identity fields (title/company) — ` +
              'every card on this page failed gateCards identity validation';
            stat.failures.push({ kind: 'field-validation', message });
            ctx.logger.warn('linkedin lane: url failed', { url, message });
            break;
          }

          // companiesSeen = post-gate (passing) card companies, deduped
          // — recorded regardless of whether this card's JD open below
          // later succeeds (spec: card-gate decides "seen", not scrape
          // success).
          for (const card of pass) state.companiesSeen.add(card.company);

          ctx.logger.info('linkedin lane: page harvested', {
            url,
            page: pageIndex,
            harvested: cards.length,
            gated: pass.length,
          });

          for (const card of pass) {
            await processCard(card, page, inv, url, stat, capLoop, state, deps, ctx);
            if (state.throttleTripped) break;
          }
          if (state.throttleTripped) break;

          // Stop-condition check (spec §2): (a) this page harvested
          // zero cards, (b) this page's harvested card-id set is
          // identical to the previous page's (LinkedIn repeats its
          // last page once `start` overshoots the true result count),
          // or (c) the per-url processed-card cap has already been
          // reached — no point fetching a page whose cards can't be
          // processed anyway.
          const cardIds = new Set(cards.map((card) => card.id));
          // A page harvesting zero cards is ordinary end-of-results
          // (harvestCards' allowEmpty already turned "container never
          // attached" and "read came back empty" into a plain []
          // return for pages >= 2) — informational, never a warn, and
          // never a SoftError.
          if (cards.length === 0) {
            ctx.logger.info('linkedin lane: end of results — stopping pagination', {
              url,
              page: pageIndex,
            });
          }
          const stop =
            cards.length === 0 ||
            (previousCardIds !== null && sameCardIdSet(previousCardIds, cardIds)) ||
            stat.cardsAttempted >= deps.maxCardsPerUrl;
          if (stop) break;
          previousCardIds = cardIds;
        }

        // Every attempted card's JD-open failed: this url's harvest
        // looked healthy (goto/harvest/gate all succeeded) but zero
        // JDs actually came out of it — shaped like a mid-url outage
        // (e.g. a logout wall hit only once detail panes start
        // opening), not a clean "nothing to capture" url. Treat it
        // the same as a thrown url failure: don't markDone (so it's
        // retried next fire) and count it toward the aggregate
        // all-urls-failed check below. Uses `cardsAttempted` (post
        // cache/dedup/cap filtering), not `pass.length` — a url whose
        // gate-passed cards were all cache-hits or cross-url dupes
        // legitimately opens zero JDs and must NOT be misread as an
        // outage.
        if (stat.cardsAttempted > 0 && stat.captured === 0) {
          stat.failed = true;
          ctx.logger.warn('linkedin lane: every card JD-open failed for url', {
            url,
            cardCount: stat.cardsAttempted,
          });
        }
      } catch (err) {
        stat.failed = true;
        // Same failure-kind classification as the per-card catch in
        // `cards.ts`, but for whole-url failures: harvestCards' own "list
        // never attached" / "below min" guards (harvest.ts) are the
        // zero-cards-in-DOM signal; a ZodError here is gateCards'
        // card-gate-drop path hitting the same empty-identity-field
        // problem as the per-card catch; anything else (goto timeout,
        // dead CDP newPage, etc.) is its own "other" kind rather than
        // being guessed at.
        if (err instanceof z.ZodError) {
          stat.failures.push({
            kind: 'field-validation',
            message: zodIssuesMessage(err),
          });
        } else if (
          err instanceof Error &&
          /results list never attached|is below min \d+/.test(err.message)
        ) {
          stat.failures.push({ kind: 'zero-cards', message: err.message });
        } else {
          stat.failures.push({
            kind: 'other',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        const soft = toSoftError('url', url, err);
        ctx.logger.warn('linkedin lane: url failed', { url, message: soft.message });
      } finally {
        if (page) await page.close();
      }

      // markDone only on success — a url whose goto/harvest/newPage
      // threw must be retried on the next fire, not skipped as done.
      // A url cut short by a throttle trip is likewise unfinished: its
      // remaining cards were never attempted, so it must not be
      // recorded as complete.
      if (!stat.failed && !state.throttleTripped) {
        state.resumeState.markDone(url, stat.captured);
      }
      // Persisted after EVERY url (success or failure), not once at
      // the end — a mid-run SIGKILL must lose at most the in-flight
      // url's mark, never every mark made so far this run.
      await state.resumeState.persist(deps.storage);
      if (state.throttleTripped) break;
    }
    if (state.throttleTripped) break;
  }
}
