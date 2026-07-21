import { isSoftError, SoftError } from '../../../core/errors/index.ts';
import type { FilterConfig } from '../../../core/filter/config.ts';
import { type DroppedRecord, type JD, JDSchema } from '../../../core/jd/index.ts';
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

  constructor(
    browser: BrowserProvider,
    inventories: Inventory[],
    urls: SearchUrlGroup[],
    filterCfg: FilterConfig,
    storage: Storage,
  ) {
    this.browser = browser;
    this.inventories = inventories;
    this.urls = urls;
    this.filterCfg = filterCfg;
    this.storage = storage;
  }

  async source(
    ctx: RunContext,
  ): Promise<{ jobs: JD[]; dropped: DroppedRecord[]; companiesSeen: string[] }> {
    const resumeState = await ResumeState.load(this.storage, todayIso());
    const captureStore = await CaptureStore.load(this.storage);

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
            const cards = await harvestCards(page, inv, ctx);
            const { pass, dropped: gateDropped } = gateCards(cards, this.filterCfg);
            dropped.push(...gateDropped);

            // companiesSeen = post-gate (passing) card companies, deduped
            // — recorded regardless of whether this card's JD open below
            // later succeeds (spec: card-gate decides "seen", not scrape
            // success).
            for (const card of pass) companiesSeen.add(card.company);

            for (const card of pass) {
              ctx.beat();
              try {
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
              } catch (err) {
                const soft = toSoftError('url', card.url, err);
                ctx.logger.warn('linkedin lane: card JD open failed', {
                  url: card.url,
                  message: soft.message,
                });
              }
            }
          } catch (err) {
            urlFailed = true;
            failedUrls += 1;
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

    // Every attempted url failed: this is not one broken selector, it's
    // shaped like an expired LinkedIn session (logout wall) — fail loud
    // rather than a silently-green zero-job run (v0 checkAggregateFailure).
    if (attemptedUrls > 0 && failedUrls === attemptedUrls) {
      throw new Error(
        `linkedin lane: all ${attemptedUrls} attempted url(s) failed this run — ` +
          'looks like an expired LinkedIn session (logout wall); check .chrome-debug/ session',
      );
    }

    return { jobs: captureStore.all(), dropped, companiesSeen: [...companiesSeen] };
  }
}
