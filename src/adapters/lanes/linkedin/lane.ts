import { isSoftError, SoftError } from '../../../core/errors/index.ts';
import type { FilterConfig } from '../../../core/filter/config.ts';
import { type JD, JDSchema } from '../../../core/jd/index.ts';
import type { BrowserProvider } from '../../../ports/browser.ts';
import type { RunContext } from '../../../ports/context.ts';
import type { FarmingLane } from '../../../ports/lane.ts';
import type { Storage } from '../../../ports/storage.ts';
import { gateCards, harvestCards } from './harvest.ts';
import type { Inventory } from './inventory.ts';
import { openJd } from './jd_open.ts';
import { ResumeState } from './resume_state.ts';

/**
 * LinkedIn farming lane (P4 Task 7): composes inventory + harvest/gate +
 * jd_open + resume_state into a FarmingLane. Owns fail-soft granularity
 * (spec §7): one URL group with no matching inventory, one URL whose
 * goto/harvest fails, or one card whose JD open fails are each recorded as
 * a SoftError and the lane continues — only the lane's OWN failure
 * (browser.launch rejecting, e.g. Chrome won't launch / login dead) is
 * thrown loud out of source().
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

  /** In-lane SoftError report (spec §7) — the runner/orchestrator may
   * inspect this after source() resolves; every entry here was also
   * logged via ctx.logger.warn at the point it occurred. */
  readonly errors: SoftError[] = [];

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

  async source(ctx: RunContext): Promise<{ jobs: JD[]; companiesSeen: string[] }> {
    this.errors.length = 0;
    const resumeState = await ResumeState.load(this.storage, todayIso());

    const jobs: JD[] = [];
    const companiesSeen = new Set<string>();

    // Lane's own failure (Chrome won't launch / login dead) is loud —
    // deliberately NOT caught here.
    const handle = await this.browser.launch(ctx);
    try {
      for (const group of this.urls) {
        const inv = this.inventories.find((candidate) => candidate.page === group.page);
        if (!inv) {
          this.recordError(
            ctx,
            'group',
            group.page,
            `no inventory found for page "${group.page}"`,
          );
          continue;
        }

        for (const url of group.urls) {
          if (resumeState.shouldSkip(url)) {
            ctx.logger.info('linkedin lane: skipping already-done url', { url });
            continue;
          }

          let capturedCount = 0;
          const page = await handle.newPage();
          try {
            await page.goto(url, { timeoutMs: DEFAULT_GOTO_TIMEOUT_MS });
            const cards = await harvestCards(page, inv, ctx);
            const { pass } = gateCards(cards, this.filterCfg);

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
                jobs.push(jd);
                capturedCount += 1;
              } catch (err) {
                const soft = toSoftError('url', card.url, err);
                this.errors.push(soft);
                ctx.logger.warn('linkedin lane: card JD open failed', {
                  url: card.url,
                  message: soft.message,
                });
              }
            }
          } catch (err) {
            const soft = toSoftError('url', url, err);
            this.errors.push(soft);
            ctx.logger.warn('linkedin lane: url failed', { url, message: soft.message });
          } finally {
            await page.close();
          }

          resumeState.markDone(url, capturedCount);
        }
      }
    } finally {
      await handle.close();
    }

    await resumeState.persist(this.storage);

    return { jobs, companiesSeen: [...companiesSeen] };
  }

  private recordError(
    ctx: RunContext,
    scope: string,
    target: string,
    message: string,
  ): void {
    const soft = new SoftError(scope, `${target}: ${message}`);
    this.errors.push(soft);
    ctx.logger.warn('linkedin lane: soft error', { scope, target, message });
  }
}
