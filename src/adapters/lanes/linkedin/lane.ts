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
import { gateCards, type HarvestedCard, harvestCards } from './harvest.ts';
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

/** Randomized pause BETWEEN saved-search urls (throttle guard D2,
 * 2026-07-28). Same no-op-by-default posture as the jitter constants
 * directly above: `(0, 0)` here so every pre-existing `new LinkedInLane(...)`
 * call site keeps its original speed, with the real production range
 * (20_000, 45_000) applied once at wiring time by
 * `resolveInterUrlDelayRange` in `cli/wire.ts`. */
const DEFAULT_INTER_URL_DELAY_MIN_MS = 0;
const DEFAULT_INTER_URL_DELAY_MAX_MS = 0;

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

/** PURE — builds the url for page `pageIndex` (1-based) of a paginated
 * LinkedIn search. Page 1 returns `baseUrl` byte-unchanged — no `start=0`
 * is ever added, matching the pre-pagination behavior exactly. Page N>=2
 * sets/overrides the query param named by `param` to
 * `(pageIndex - 1) * pageSize`, via the WHATWG URL API so every other
 * query param already on `baseUrl` is preserved untouched. */
export function buildPageUrl(
  baseUrl: string,
  pageIndex: number,
  param: string,
  pageSize: number,
): string {
  if (pageIndex <= 1) return baseUrl;
  const url = new URL(baseUrl);
  url.searchParams.set(param, String((pageIndex - 1) * pageSize));
  return url.toString();
}

/** Parsed pagination behaviors off a page inventory (`behaviors.
 * paginationType/paginationParam/paginationPageSize/maxPages` — all
 * inventory-declared strings, `inventory.ts`'s `InventorySchema` keeps
 * `behaviors` as a free-form string record). Falls back to a single page
 * (the exact pre-pagination behavior) whenever `paginationType` isn't
 * `"url-pages"` or any needed field is missing/unparseable, rather than
 * guessing a default range. */
interface PaginationConfig {
  param: string;
  pageSize: number;
  maxPages: number;
}

const SINGLE_PAGE_PAGINATION: PaginationConfig = {
  param: 'start',
  pageSize: 0,
  maxPages: 1,
};

function resolvePagination(inv: Inventory, ctx: RunContext): PaginationConfig {
  const b = inv.behaviors;
  if (b.paginationType !== 'url-pages') return SINGLE_PAGE_PAGINATION;
  const param = b.paginationParam;
  const pageSize = Number.parseInt(b.paginationPageSize ?? '', 10);
  const maxPages = Number.parseInt(b.maxPages ?? '', 10);
  if (
    !param ||
    !Number.isFinite(pageSize) ||
    pageSize <= 0 ||
    !Number.isFinite(maxPages) ||
    maxPages <= 0
  ) {
    ctx.logger.debug(
      'linkedin lane: pagination behaviors missing/unparseable — treating url as single-page',
      { page: inv.page },
    );
    return SINGLE_PAGE_PAGINATION;
  }
  return { param, pageSize, maxPages };
}

/** PURE — true when two harvested-card id sets are identical (order-
 * independent). Detects LinkedIn repeating its last page of results once
 * `start` overshoots the true result count — the same id/link key
 * (`HarvestedCard.id`) the run-dedup Set (`processedIds`) uses. */
function sameCardIdSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
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

/** Distinct whole-url/per-card failure shapes, counted (with one sample
 * message each) separately in the all-urls-failed evidence rather than
 * collapsed into a single guessed cause — see the throw site in source(). */
type FailureKind = 'zero-cards' | 'field-validation' | 'jd-open' | 'other';

/** Per-url bookkeeping for one source() run — the single record the
 * aggregate guards, the failure evidence, and the extraction-source
 * observability are all derived from (replaces the parallel scalar
 * counters that previously fed each of those independently). */
interface UrlStat {
  url: string;
  /** Cards that reached a JD open (post gate/cache/dedup/cap filtering). */
  cardsAttempted: number;
  captured: number;
  /** Captures whose text came from the anchor-text fallback, not jdRoot. */
  anchorExtractions: number;
  failed: boolean;
  failures: Array<{ kind: FailureKind; message: string }>;
}

function zodIssuesMessage(err: z.ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

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
  private readonly interUrlDelayMinMs: number;
  private readonly interUrlDelayMaxMs: number;

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

    // One UrlStat per attempted url — everything the post-loop guards and
    // observability need (aggregate-failure detection, the lane-wide
    // "no JD ever opened" guard that caught the 2026-07-25 incident, the
    // per-kind failure evidence, extraction-source counts) is derived
    // from these records after the loop instead of being tracked in
    // parallel scalar counters.
    const stats: UrlStat[] = [];

    // Lane's own failure (Chrome won't launch) is loud — deliberately NOT
    // caught here.
    const handle = await this.browser.launch(ctx);
    try {
      // True once this run has actually attempted a url. Gates the inter-url
      // pause so it never fires before the first attempt, and — because it is
      // declared outside the group loop — still fires across a group boundary.
      let attemptedAnyUrl = false;
      for (const group of this.urls) {
        const inv = this.inventories.find((candidate) => candidate.page === group.page);
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
          if (resumeState.shouldSkip(url)) {
            ctx.logger.info('linkedin lane: skipping already-done url', { url });
            continue;
          }

          // Placed AFTER the skip check on purpose: a url this fire never
          // touches must not cost 20-45s of wall clock. Deliberately outside
          // the per-url try/catch below — the only way sleepFn rejects is an
          // aborted ctx.signal, which must propagate loud (the run is over),
          // not be recorded as this url's SoftError.
          if (attemptedAnyUrl) await this.interUrlPause(ctx);
          attemptedAnyUrl = true;

          const stat: UrlStat = {
            url,
            cardsAttempted: 0,
            captured: 0,
            anchorExtractions: 0,
            failed: false,
            failures: [],
          };
          stats.push(stat);
          let page: PageHandle | undefined;
          try {
            // newPage() lives INSIDE this try: a dead CDP context (e.g.
            // LinkedIn killing a tab) is this url's failure alone, not a
            // whole-lane crash.
            page = await handle.newPage();

            // capLoggedThisUrl/previousCardIds are per-URL, accumulated
            // across that url's pages (not reset per page).
            let capLoggedThisUrl = false;
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
                await this.jitter(ctx);
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

              const { pass, dropped: gateDropped } = gateCards(cards, this.filterCfg);
              dropped.push(...gateDropped);

              // companiesSeen = post-gate (passing) card companies, deduped
              // — recorded regardless of whether this card's JD open below
              // later succeeds (spec: card-gate decides "seen", not scrape
              // success).
              for (const card of pass) companiesSeen.add(card.company);

              ctx.logger.info('linkedin lane: page harvested', {
                url,
                page: pageIndex,
                harvested: cards.length,
                gated: pass.length,
              });

              // Cheapest-first below (P9 closure register §1, Task B): the
              // card gate already ran (gateCards, above); next comes the
              // cache-skip and cross-url dedup (cheap Set lookups), then
              // the per-url cap (backstop, loud when it fires), and only
              // then the expensive JD open.
              for (const card of pass) {
                if (cacheIds.has(card.id)) {
                  continue;
                }
                if (processedIds.has(card.id)) {
                  continue;
                }
                if (stat.cardsAttempted >= this.maxCardsPerUrl) {
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
                stat.cardsAttempted += 1;
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
                  const { text: rawText, source } = await openJd(page, card, inv, ctx);
                  if (source === 'anchor') stat.anchorExtractions += 1;
                  const jd = JDSchema.parse({
                    identity: {
                      id: card.id,
                      lane: 'linkedin',
                      url: card.url,
                      company: card.company,
                      title: card.title,
                      scrapedAt: new Date().toISOString(),
                      location: card.location,
                    },
                    content: { rawText },
                  });
                  await captureStore.append(this.storage, jd);
                  stat.captured += 1;
                } catch (err) {
                  // Distinguish "JD pane genuinely failed to open" (openJd
                  // already wraps that as a SoftError) from "the card's own
                  // identity fields — title/company — came back empty and
                  // JDSchema.parse rejected them" (a plain ZodError, thrown
                  // here rather than inside openJd). These are different bugs
                  // with different fixes, so they must not be folded into one
                  // failure kind below.
                  stat.failures.push(
                    err instanceof z.ZodError
                      ? { kind: 'field-validation', message: zodIssuesMessage(err) }
                      : {
                          kind: 'jd-open',
                          message: err instanceof Error ? err.message : String(err),
                        },
                  );
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
                stat.cardsAttempted >= this.maxCardsPerUrl;
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
            // Same failure-kind classification as the per-card catch above,
            // but for whole-url failures: harvestCards' own "list never
            // attached" / "below min" guards (harvest.ts) are the
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
          if (!stat.failed) {
            resumeState.markDone(url, stat.captured);
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
    const failures = stats.flatMap((s) => s.failures);
    const countOf = (kind: FailureKind) => failures.filter((f) => f.kind === kind).length;
    const sampleOf = (kind: FailureKind) =>
      failures.find((f) => f.kind === kind)?.message;

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
    // see memory/extract-flaky root-cause notes). Report the observed
    // evidence and let it point at distinct candidate causes instead of
    // asserting one guessed cause.
    if (attemptedUrls > 0 && failedUrls === attemptedUrls) {
      const evidence: string[] = [];
      const zeroCards = countOf('zero-cards');
      if (zeroCards > 0) {
        const sample = sampleOf('zero-cards');
        evidence.push(
          `${zeroCards}/${attemptedUrls} url(s) found zero (or too few) cards in ` +
            `the DOM${sample ? ` (e.g. "${sample}")` : ''} — ` +
            'consistent with an authwall/logout wall OR a broken results-list selector; ' +
            'candidates: check .chrome-debug/ session state, and/or whether the ' +
            'list-container selector still matches (src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json).',
        );
      }
      const fieldValidation = countOf('field-validation');
      if (fieldValidation > 0) {
        const sample = sampleOf('field-validation');
        evidence.push(
          `${fieldValidation} card(s) had empty/invalid title or company after ` +
            `extraction${sample ? ` (e.g. "${sample}")` : ''} ` +
            '— cards WERE found in the DOM, but field extraction failed schema validation; ' +
            'this points at drifted title/company sub-selectors in ' +
            'src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json, NOT a session problem.',
        );
      }
      const jdOpen = countOf('jd-open');
      if (jdOpen > 0) {
        const sample = sampleOf('jd-open');
        evidence.push(
          `${jdOpen} card(s) were found and extracted, but JD-open failed for ` +
            `them${sample ? ` (e.g. "${sample}")` : ''} — a different ` +
            'failure mode from the above two; check the jdRoot selector or JD-pane load timing.',
        );
      }
      const other = countOf('other');
      if (other > 0) {
        const sample = sampleOf('other');
        evidence.push(
          `${other} url(s) failed for other reasons${sample ? ` (e.g. "${sample}")` : ''}.`,
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
    // Throwing is the discard-everything channel, though: the lane's
    // return value is captureStore.all(), which a resumed/second same-day
    // fire seeds with the EARLIER fire's persisted captures — so when
    // real captured work coexists with this fire's outage, the outage is
    // logged loudly and the preserved JDs are returned instead of thrown
    // away (review finding 4).
    if (totalCardsAttempted > 0 && totalCaptured === 0) {
      const priorCaptures = captureStore.all().length;
      if (priorCaptures === 0) {
        throw new Error(
          `linkedin lane: ${totalCardsAttempted} card(s) were attempted across ` +
            `${attemptedUrls} url(s) this run, but zero JDs were captured — every JD-open ` +
            'failed. Check the JD-open path (openJd, jd_open.ts) and whether the jdRoot ' +
            'selector still matches (src/adapters/lanes/linkedin/page_inventory/linkedin__jobs-search.json).',
        );
      }
      ctx.logger.warn(
        'linkedin lane: every JD-open failed this fire — returning JDs preserved from an earlier same-day fire instead of failing the run',
        { totalCardsAttempted, attemptedUrls, priorCaptures },
      );
    }

    return { jobs: captureStore.all(), dropped, companiesSeen: [...companiesSeen] };
  }
}
