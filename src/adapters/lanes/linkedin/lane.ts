import { z } from 'zod';
import { sleep } from '../../../core/async/index.ts';
import { isSoftError, SoftError } from '../../../core/errors/index.ts';
import type { FilterConfig } from '../../../core/filter/config.ts';
import {
  CacheEntrySchema,
  type DroppedRecord,
  type JD,
  JDSchema,
} from '../../../core/jd/index.ts';
import type { BrowserProvider, PageHandle } from '../../../ports/browser.ts';
import type { RunContext } from '../../../ports/context.ts';
import type { FarmingLane } from '../../../ports/lane.ts';
import type { Storage } from '../../../ports/storage.ts';
import { CaptureStore } from './capture_store.ts';
import { gateCards, harvestCards } from './harvest.ts';
import type { Inventory } from './inventory.ts';
import { openJd } from './jd_open.ts';
import { ResumeState } from './resume_state.ts';

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

/** Randomized inter-request pacing before every network-facing navigation
 * (P9 tail: confirmed v0->v2 parity regression — LinkedIn served an
 * enterprise reCAPTCHA to a scraping profile that skipped v0's delays).
 * The CLASS default here is deliberately a no-op range (0, 0) — NOT v0's
 * (2000, 5000) — so every direct `new LinkedInLane(...)` call site that
 * predates this fix (this file's whole test suite) keeps running at its
 * original speed instead of silently gaining a real multi-second sleep
 * per card/url. The real v0-parity default (2000, 5000) is applied
 * exactly once, at production wiring time, by `resolveJitterRange` in
 * `cli/wire.ts` (its own same-named constants) — the only caller that
 * needs it live. */
const DEFAULT_JITTER_MIN_MS = 0;
const DEFAULT_JITTER_MAX_MS = 0;

/** PURE — [minMs, maxMs) jitter amount, v0 parity
 * (scripts/lib/page_actions.js's jitterMs). `rand` is injectable for
 * deterministic tests — mirrors v0's own `rand = Math.random` param. */
export function jitterMs(
  minMs: number,
  maxMs: number,
  rand: () => number = Math.random,
): number {
  return minMs + Math.floor(rand() * (maxMs - minMs));
}

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

export interface SearchUrlGroup {
  page: string;
  urls: string[];
}

/**
 * Parses `search_urls.md`'s hierarchical Channel -> page -> labeled-URLs
 * format (v0 format unchanged, scripts/pipeline/extract/parse.js). Each
 * `### <page>` heading starts a group named `<page>` (the `<!-- inventory:
 * ... -->` comment beneath it is v0-only path plumbing — v2 resolves the
 * Inventory for a group by matching `page` against the lane's own
 * `inventories` array instead, so the comment is ignored here); each
 * `  • <label> - <url>` line beneath it is appended to that group. `##`
 * channel headings are structural only and don't affect grouping. Groups
 * with zero URLs are dropped.
 */
export function parseSearchUrls(md: string): SearchUrlGroup[] {
  const groups = new Map<string, string[]>();
  let currentPage: string | null = null;

  for (const raw of md.split('\n')) {
    const line = raw.trim();
    const pageMatch = line.match(/^###\s+(.+)$/);
    if (pageMatch?.[1]) {
      currentPage = pageMatch[1].trim();
      if (!groups.has(currentPage)) groups.set(currentPage, []);
      continue;
    }
    if (!currentPage) continue;
    const urlMatch = line.match(/^[•*-]\s+.+?\s+-\s+(https?:\/\/\S+)$/);
    if (urlMatch?.[1]) {
      groups.get(currentPage)?.push(urlMatch[1].trim());
    }
  }

  return [...groups.entries()]
    .map(([page, urls]) => ({ page, urls }))
    .filter((group) => group.urls.length > 0);
}

const DEFAULT_GOTO_TIMEOUT_MS = 30_000;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Normalizes any thrown value into a SoftError of the given scope,
 * passing an already-SoftError through unchanged (its message already
 * carries the relevant context, e.g. jd_open's card url). */
function toSoftError(scope: string, target: string, err: unknown): SoftError {
  if (isSoftError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new SoftError(scope, `${target}: ${message}`, { cause: err });
}

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

  async source(
    ctx: RunContext,
  ): Promise<{ jobs: JD[]; dropped: DroppedRecord[]; companiesSeen: string[] }> {
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

    // Aggregate-failure detection (spec §7 fail-soft granularity, but a
    // whole-run "every attempted url died" is not one flaky selector —
    // see the loud check after the loop).
    let attemptedUrls = 0;
    let failedUrls = 0;

    // Lane-wide "no JD ever opened" guard (distinct from, and in addition
    // to, the per-url and all-urls-failed guards above/below): a url whose
    // cards all survive title-gating but whose JD-opens all fail is only
    // caught by the per-url guard if it also lands on failedUrls ===
    // attemptedUrls — a url where NOTHING survives gating (cardsAttempted
    // === 0) never becomes a failedUrl, so it can silently drag
    // attemptedUrls above failedUrls and mask a 100%-JD-open-failure run
    // (2026-07-25 incident: url A attempted 2, both failed; url B
    // attempted 0; failedUrls (1) !== attemptedUrls (2), no throw,
    // outcome: "passed"). These totals are summed across every url,
    // independent of per-url pass/fail bookkeeping, so this guard fires on
    // the aggregate even when no single url is "the" failed one.
    let totalCardsAttempted = 0;
    let totalCaptured = 0;

    // Evidence for the all-urls-failed message below: distinct failure
    // shapes get counted (and one sample message kept) separately, rather
    // than collapsed into a single guessed cause. See the throw site for
    // why these three buckets in particular.
    let zeroCardHarvests = 0;
    let sampleZeroCardsMsg: string | undefined;
    let fieldValidationFailures = 0;
    let sampleFieldValidationMsg: string | undefined;
    let jdOpenFailures = 0;
    let sampleJdOpenMsg: string | undefined;
    let otherUrlFailures = 0;
    let sampleOtherMsg: string | undefined;

    // Lane's own failure (Chrome won't launch) is loud — deliberately NOT
    // caught here.
    const handle = await this.browser.launch(ctx);
    try {
      for (const group of this.urls) {
        const inv = this.inventories.find((candidate) => candidate.page === group.page);
        if (!inv) {
          ctx.logger.warn('linkedin lane: no inventory found for page', {
            page: group.page,
          });
          continue;
        }

        for (const url of group.urls) {
          if (resumeState.shouldSkip(url)) {
            ctx.logger.info('linkedin lane: skipping already-done url', { url });
            continue;
          }

          attemptedUrls += 1;
          let capturedCount = 0;
          let urlFailed = false;
          let page: PageHandle | undefined;
          try {
            // newPage() lives INSIDE this try: a dead CDP context (e.g.
            // LinkedIn killing a tab) is this url's failure alone, not a
            // whole-lane crash.
            page = await handle.newPage();
            await page.goto(url, { timeoutMs: DEFAULT_GOTO_TIMEOUT_MS });
            // v0 parity placement: jitter comes AFTER goto, BEFORE the
            // page is read (scripts/pipeline/extract/cards.js:187/:204 —
            // `await gotoWithRetry(...); await jitterFn();`, immediately
            // preceding runAssertions/collectCards, harvestCards' v2
            // counterpart).
            await this.jitter(ctx);
            const cards = await harvestCards(page, inv, ctx);
            const { pass, dropped: gateDropped } = gateCards(cards, this.filterCfg);
            dropped.push(...gateDropped);

            // companiesSeen = post-gate (passing) card companies, deduped
            // — recorded regardless of whether this card's JD open below
            // later succeeds (spec: card-gate decides "seen", not scrape
            // success).
            for (const card of pass) companiesSeen.add(card.company);

            // Cheapest-first below (P9 closure register §1, Task B): the
            // card gate already ran (gateCards, above); next comes the
            // cache-skip and cross-url dedup (cheap Set lookups), then
            // the per-url cap (backstop, loud when it fires), and only
            // then the expensive JD open.
            let cardsAttempted = 0;
            let capLoggedThisUrl = false;
            for (const card of pass) {
              if (cacheIds.has(card.id)) {
                continue;
              }
              if (processedIds.has(card.id)) {
                continue;
              }
              if (cardsAttempted >= this.maxCardsPerUrl) {
                if (!capLoggedThisUrl) {
                  capLoggedThisUrl = true;
                  ctx.logger.warn(
                    'linkedin lane: maxCardsPerUrl cap hit — dropping remainder for this url',
                    { url, maxCardsPerUrl: this.maxCardsPerUrl },
                  );
                }
                dropped.push({
                  jd: JDSchema.parse({
                    identity: {
                      id: card.id,
                      lane: 'linkedin',
                      url: card.url,
                      company: card.company,
                      title: card.title,
                      scrapedAt: new Date().toISOString(),
                    },
                  }),
                  reasons: [
                    {
                      rule: 'linkedin.maxCardsPerUrlCap',
                      severity: 'hard',
                      pass: false,
                      detail: `maxCardsPerUrl=${this.maxCardsPerUrl} reached for url "${url}"`,
                    },
                  ],
                });
                continue;
              }

              processedIds.add(card.id);
              cardsAttempted += 1;
              totalCardsAttempted += 1;
              ctx.beat();
              try {
                // v0 parity placement: jitter before every JD open
                // (scripts/pipeline/extract.js:282 — `await jitter();`
                // immediately preceding captureJd). Inside this card's
                // own try (a deviation from v0, which has no abort
                // concept): an aborted jitter is this one card's
                // SoftError, same as any other openJd failure below, not
                // an uncaught throw out of the whole card loop.
                await this.jitter(ctx);
                const rawText = await openJd(page, card, inv, ctx);
                const jd = JDSchema.parse({
                  identity: {
                    id: card.id,
                    lane: 'linkedin',
                    url: card.url,
                    company: card.company,
                    title: card.title,
                    scrapedAt: new Date().toISOString(),
                  },
                  content: { rawText },
                });
                await captureStore.append(this.storage, jd);
                capturedCount += 1;
                totalCaptured += 1;
              } catch (err) {
                // Distinguish "JD pane genuinely failed to open" (openJd
                // already wraps that as a SoftError) from "the card's own
                // identity fields — title/company — came back empty and
                // JDSchema.parse rejected them" (a plain ZodError, thrown
                // here rather than inside openJd). These are different bugs
                // with different fixes, so they must not be folded into one
                // counter/message below.
                if (err instanceof z.ZodError) {
                  fieldValidationFailures += 1;
                  sampleFieldValidationMsg ??= err.issues
                    .map(
                      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
                    )
                    .join('; ');
                } else {
                  jdOpenFailures += 1;
                  sampleJdOpenMsg ??= err instanceof Error ? err.message : String(err);
                }
                const soft = toSoftError('url', card.url, err);
                ctx.logger.warn('linkedin lane: card JD open failed', {
                  url: card.url,
                  message: soft.message,
                });
                // A per-card JD-open failure must still show up in the
                // funnel — an identity-only JD (no content yet, same
                // shape as gateCards' card-gate drops) paired with the
                // failure reason, so it can always answer "why did this
                // disappear?" instead of only a log line.
                dropped.push({
                  jd: JDSchema.parse({
                    identity: {
                      id: card.id,
                      lane: 'linkedin',
                      url: card.url,
                      company: card.company,
                      title: card.title,
                      scrapedAt: new Date().toISOString(),
                    },
                  }),
                  reasons: [
                    {
                      rule: 'linkedin.jdOpenFailed',
                      severity: 'hard',
                      pass: false,
                      detail: soft.message,
                    },
                  ],
                });
              }
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
            if (cardsAttempted > 0 && capturedCount === 0) {
              urlFailed = true;
              failedUrls += 1;
              ctx.logger.warn('linkedin lane: every card JD-open failed for url', {
                url,
                cardCount: cardsAttempted,
              });
            }
          } catch (err) {
            urlFailed = true;
            failedUrls += 1;
            // Same evidence-gathering as the per-card catch above, but for
            // whole-url failures: harvestCards' own "list never attached" /
            // "below min" guards (harvest.ts) are the zero-cards-in-DOM
            // signal; a ZodError here is gateCards' card-gate-drop path
            // hitting the same empty-identity-field problem as the per-card
            // catch; anything else (goto timeout, dead CDP newPage, etc.) is
            // its own "other" bucket rather than being guessed at.
            if (err instanceof z.ZodError) {
              fieldValidationFailures += 1;
              sampleFieldValidationMsg ??= err.issues
                .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                .join('; ');
            } else if (
              err instanceof Error &&
              /results list never attached|is below min \d+/.test(err.message)
            ) {
              zeroCardHarvests += 1;
              sampleZeroCardsMsg ??= err.message;
            } else {
              otherUrlFailures += 1;
              sampleOtherMsg ??= err instanceof Error ? err.message : String(err);
            }
            const soft = toSoftError('url', url, err);
            ctx.logger.warn('linkedin lane: url failed', { url, message: soft.message });
          } finally {
            if (page) await page.close();
          }

          // markDone only on success — a url whose goto/harvest/newPage
          // threw must be retried on the next fire, not skipped as done.
          if (!urlFailed) {
            resumeState.markDone(url, capturedCount);
          }
          // Persisted after EVERY url (success or failure), not once at
          // the end — a mid-run SIGKILL must lose at most the in-flight
          // url's mark, never every mark made so far this run.
          await resumeState.persist(this.storage);
        }
      }
    } finally {
      await handle.close();
    }

    // Every attempted url failed: this is not one broken selector — fail
    // loud rather than a silently-green zero-job run (v0
    // checkAggregateFailure). It is NOT always an expired session, though
    // (2026-07-25: a healthy session failed this guard because card
    // title/company selectors had drifted, not because of a logout wall —
    // see memory/extract-flaky root-cause notes). Report the observed
    // evidence and let it point at distinct candidate causes instead of
    // asserting one guessed cause.
    if (attemptedUrls > 0 && failedUrls === attemptedUrls) {
      const evidence: string[] = [];
      if (zeroCardHarvests > 0) {
        evidence.push(
          `${zeroCardHarvests}/${attemptedUrls} url(s) found zero (or too few) cards in ` +
            `the DOM${sampleZeroCardsMsg ? ` (e.g. "${sampleZeroCardsMsg}")` : ''} — ` +
            'consistent with an authwall/logout wall OR a broken results-list selector; ' +
            'candidates: check .chrome-debug/ session state, and/or whether the ' +
            'list-container selector still matches (page_inventory/linkedin__jobs-search.json).',
        );
      }
      if (fieldValidationFailures > 0) {
        evidence.push(
          `${fieldValidationFailures} card(s) had empty/invalid title or company after ` +
            `extraction${sampleFieldValidationMsg ? ` (e.g. "${sampleFieldValidationMsg}")` : ''} ` +
            '— cards WERE found in the DOM, but field extraction failed schema validation; ' +
            'this points at drifted title/company sub-selectors in ' +
            'page_inventory/linkedin__jobs-search.json, NOT a session problem.',
        );
      }
      if (jdOpenFailures > 0) {
        evidence.push(
          `${jdOpenFailures} card(s) were found and extracted, but JD-open failed for ` +
            `them${sampleJdOpenMsg ? ` (e.g. "${sampleJdOpenMsg}")` : ''} — a different ` +
            'failure mode from the above two; check the jdRoot selector or JD-pane load timing.',
        );
      }
      if (otherUrlFailures > 0) {
        evidence.push(
          `${otherUrlFailures} url(s) failed for other reasons` +
            `${sampleOtherMsg ? ` (e.g. "${sampleOtherMsg}")` : ''}.`,
        );
      }
      throw new Error(
        `linkedin lane: all ${attemptedUrls} attempted url(s) failed this run. ` +
          (evidence.length > 0
            ? evidence.join(' ')
            : 'No further diagnostic evidence was captured for the underlying failures.'),
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
    if (totalCardsAttempted > 0 && totalCaptured === 0) {
      throw new Error(
        `linkedin lane: ${totalCardsAttempted} card(s) were attempted across ` +
          `${attemptedUrls} url(s) this run, but zero JDs were captured — every JD-open ` +
          'failed. Check the JD-open path (openJd, jd_open.ts) and whether the jdRoot ' +
          'selector still matches (page_inventory/linkedin__jobs-search.json).',
      );
    }

    return { jobs: captureStore.all(), dropped, companiesSeen: [...companiesSeen] };
  }
}
