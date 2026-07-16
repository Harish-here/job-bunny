// scripts/pipeline/extract/cards.js — card collection + pagination, moved verbatim from
// extract.js except for two rewires: wall-clock budget/log injection in collectCards and
// gotoWithRetry/scrollUntilStable adoption in collectAllPages. See the extract-rewrite task's
// behavior diff report for the exhaustive list of sanctioned deviations.

import { extractJobId } from "../../lib/util.js";
import {
  sleep,
  jitter,
  createBudget,
  gotoWithRetry,
  safeText,
  safeAttr,
  scrollUntilStable,
  DEFAULT_FIELD_TIMEOUT_MS,
} from "../../lib/page_actions.js";
import { parseList } from "./parse.js";

// ---------- card collection ----------
// Builds a canonical job_url from url_pattern_of_job (<id> placeholder) when available, so we
// store a clean URL instead of the tracking-laden href.
export function canonicalUrl(cfg, id, href, base) {
  if (id && cfg.url_pattern_of_job && cfg.url_pattern_of_job.includes("<id>")) {
    return cfg.url_pattern_of_job.replace("<id>", id);
  }
  return href ? new URL(href, base).toString() : null;
}

// ---------- assertions ----------
export async function runAssertions(page, cfg) {
  const mustExist = parseList(cfg.must_exist);
  for (const sel of mustExist) {
    if (!(await page.locator(sel).count())) throw new Error(`assertion failed: must_exist selector not found: ${sel}`);
  }
  const minCards = parseInt(cfg.min_job_cards || "1", 10);
  const count = await page.locator(cfg.job_card).count();
  if (count < minCards) throw new Error(`assertion failed: ${count} cards < min_job_cards ${minCards}`);
}

// Hard wall-clock cap on the whole loop below. Each individual locator action already has
// Playwright's own ~30s default action timeout, but nothing previously bounded the TOTAL time
// across all n cards — if the DOM keeps shifting under a card (e.g. a reflowing third-party ad
// iframe), several of those per-action timeouts can each run to their full ~30s ceiling and
// compound over dozens of cards into a many-minute hang. Once hit, log a warning and return
// whatever was collected so far rather than throwing — consistent with this file's per-URL/
// per-page skip-and-continue convention.
export async function collectCards(page, cfg, { maxMs, fieldTimeoutMs = DEFAULT_FIELD_TIMEOUT_MS, log = console } = {}) {
  const cards = page.locator(cfg.job_card);
  const n = await cards.count();
  const out = [];
  const budget = createBudget(maxMs);
  for (let i = 0; i < n; i++) {
    if (budget.expired()) {
      log.warn(
        `⚠ collectCards: hit ${maxMs}ms cap after ${i}/${n} cards — proceeding with what was collected`
      );
      break;
    }
    const card = cards.nth(i);
    // Lazy-rendered lists (e.g. LinkedIn) only populate a card's inner DOM once it's on screen.
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(120);
    // Supports ":nth(N)" suffix for pages where sibling selectors aren't usable (hashed classes).
    // e.g. "p:nth(1)" → card.locator("p").nth(1)
    const [title, company, location, href, idAttr_raw] = await Promise.all([
      safeText(card, cfg.job_card_title, { timeoutMs: fieldTimeoutMs }),
      safeText(card, cfg.job_card_company, { timeoutMs: fieldTimeoutMs }),
      safeText(card, cfg.job_card_location, { timeoutMs: fieldTimeoutMs }),
      cfg.job_card_href
        ? safeAttr(card, cfg.job_card_href, "href", { timeoutMs: fieldTimeoutMs })
        : Promise.resolve(null),
      // Reads the id attr off `card` itself (not a sub-selector), so safeAttr's
      // scope.locator(selector) shape doesn't fit — same bounded-timeout/catch-to-null
      // behavior as safeAttr, just applied directly to the card locator.
      cfg.job_card_id_attr
        ? card.getAttribute(cfg.job_card_id_attr, { timeout: fieldTimeoutMs }).catch(() => null)
        : Promise.resolve(null),
    ]);
    let idAttr = idAttr_raw;
    if (idAttr && cfg.job_card_id_attr_prefix && idAttr.startsWith(cfg.job_card_id_attr_prefix)) {
      idAttr = idAttr.slice(cfg.job_card_id_attr_prefix.length);
    }
    const job_id = idAttr || extractJobId(href);
    out.push({ index: i, title, company, location, href, job_id, job_url: canonicalUrl(cfg, job_id, href, page.url()) });
  }
  return out;
}

// ---------- pagination ----------
// Loads all pages for a URL according to cfg.pagination_type:
//   "url-pages"      — iterates start=0, 25, 50… stopping when a page returns 0 cards or fewer
//                      than pagination_page_size (signals last page). Deduplicates by job_id.
//   "infinite-scroll" (or unset) — existing scroll-and-stabilise behaviour.
// Runs runAssertions on the first page load only.
export async function collectAllPages(page, url, cfg, { cardCap = 0, collectCardsMaxMs, fieldTimeoutMs, log = console } = {}) {
  const pType = (cfg.pagination_type || "infinite-scroll").trim();

  if (pType !== "url-pages") {
    await gotoWithRetry(page, url, { log });
    await jitter();
    await scrollUntilStable(page, {
      itemSelector: cfg.job_card,
      scrollContainer: cfg.scroll_container || null,
      endSelector: cfg.end_of_results_signal || null,
    });
    await runAssertions(page, cfg);
    return collectCards(page, cfg, { maxMs: collectCardsMaxMs, fieldTimeoutMs, log });
  }

  const param    = cfg.pagination_param    || "start";
  const pageSize = parseInt(cfg.pagination_page_size || "25", 10);
  const maxPages = parseInt(cfg.max_pages  || "4", 10);
  // Honour cardCap early — stop fetching pages once we have enough cards,
  // rather than fetching all max_pages and capping afterwards.
  const seen = new Set();
  const all  = [];

  for (let p = 0; p < maxPages; p++) {
    const u = new URL(url);
    u.searchParams.set(param, p * pageSize);
    await gotoWithRetry(page, u.toString(), { log });
    await jitter();
    if (p === 0) await runAssertions(page, cfg);
    const cards = await collectCards(page, cfg, { maxMs: collectCardsMaxMs, fieldTimeoutMs, log });
    // Warn on page 2+ returning nothing — could be selector drift rather than a real last page.
    if (p > 0 && cards.length === 0) {
      log.warn(`⚠ page ${p + 1} returned 0 cards — possible selector drift`);
    }
    // Iterate (not filter+forEach) so seen is updated per-card — prevents same-page duplicates
    // from both passing the filter before the Set is updated.
    const prevLen = all.length;
    for (const card of cards) {
      if (!card.job_id || seen.has(card.job_id)) continue;
      seen.add(card.job_id);
      all.push(card);
    }
    log.log(`page ${p + 1}: ${cards.length} cards (${all.length - prevLen} new)`);
    if (cards.length === 0 || cards.length < pageSize) break;
    if (cardCap > 0 && all.length >= cardCap) break;
  }
  return all;
}
