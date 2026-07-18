// scripts/pipeline/extract/cards.js — card collection + pagination.
//
// Collection is a BATCH operation: one page.evaluate() harvests every card's fields in a single
// in-page DOM pass (collectCardsInPage), repeated in bounded scroll-and-harvest rounds until the
// row set stops growing. This replaced the per-card locator loop after a production incident:
// per-card scrollIntoViewIfNeeded() (Playwright default 30s action timeout, waits for element
// *stability*) burned ~30s on EVERY card whenever LinkedIn's occludable list was in an animating
// render state — 4 cards ate the whole 120s budget, every URL took ~2min, and full runs blew the
// scheduler's 30-min watchdog. The batch harvest needs no per-element stability, costs 2 CDP
// round-trips per round instead of 5+ per card, and every round-trip is raced against a deadline
// (withTimeout) so a wedged tab returns partial results instead of hanging the run.
//
// collectCards owns ALL scrolling for a page (there is no separate scroll-to-stable pre-pass) —
// it steps the container so the virtualizer hydrates rows as they pass through view, and honours
// cfg.end_of_results_signal via the harvest itself. Selector semantics: optional ":nth(N)"
// suffix (hashed-class pages), first non-empty innerText line, missing selector → ""/null.

import { extractJobId } from "../../lib/util.js";
import { sleep, jitter, createBudget, gotoWithRetry, withTimeout, DEFAULT_CALL_TIMEOUT_MS } from "../../lib/page_actions.js";
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
// Runs right after the page load, before any scrolling — so each check WAITS (bounded) for its
// selector to attach rather than counting a still-hydrating SPA DOM and failing a healthy page.
export async function runAssertions(page, cfg) {
  const appeared = (sel) =>
    page.locator(sel).first().waitFor({ state: "attached", timeout: DEFAULT_CALL_TIMEOUT_MS }).then(() => true, () => false);
  for (const sel of parseList(cfg.must_exist)) {
    if (!(await appeared(sel))) throw new Error(`assertion failed: must_exist selector not found: ${sel}`);
  }
  const minCards = parseInt(cfg.min_job_cards || "1", 10);
  if (minCards <= 0) return;
  await appeared(cfg.job_card);
  const count = await withTimeout(page.locator(cfg.job_card).count(), DEFAULT_CALL_TIMEOUT_MS, "job_card count");
  if (count < minCards) throw new Error(`assertion failed: ${count} cards < min_job_cards ${minCards}`);
}

// Runs INSIDE the browser via page.evaluate — must stay fully self-contained (no imports, no
// closures over module scope). Returns one raw row per cfg.job_card match plus whether
// cfg.end_of_results_signal is present; occluded/unhydrated rows come back with empty fields and
// are upgraded by a later round's harvest (mergeCardRows).
export function collectCardsInPage(cfg) {
  const firstLine = (el) => {
    const raw = ((el && el.innerText) || "").trim();
    for (const l of raw.split("\n")) if (l.trim()) return l.trim();
    return "";
  };
  const pick = (card, selector) => {
    if (!selector) return null;
    const m = selector.match(/:nth\((\d+)\)$/);
    const els = card.querySelectorAll(m ? selector.slice(0, -m[0].length) : selector);
    return els[m ? parseInt(m[1], 10) : 0] || null;
  };
  const rows = [];
  const cards = document.querySelectorAll(cfg.job_card);
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const hrefEl = pick(card, cfg.job_card_href);
    rows.push({
      index: i,
      title: firstLine(pick(card, cfg.job_card_title)),
      company: firstLine(pick(card, cfg.job_card_company)),
      location: firstLine(pick(card, cfg.job_card_location)),
      href: hrefEl ? hrefEl.getAttribute("href") : null,
      idAttr: cfg.job_card_id_attr ? card.getAttribute(cfg.job_card_id_attr) : null,
    });
  }
  const end = !!(cfg.end_of_results_signal && document.querySelector(cfg.end_of_results_signal));
  return { rows, end };
}

// Also runs in-page. One scroll step of ~80% of the container's viewport (page-level fallback
// mirrors the pre-rewrite scroller) — stepwise, not jump-to-bottom, so the virtualizer hydrates
// rows as they pass through view. Returns geometry so the caller can detect the bottom.
export function scrollStepInPage(sel) {
  const el = sel ? document.querySelector(sel) : null;
  const target = el || document.scrollingElement || document.body;
  target.scrollBy(0, Math.max(400, Math.floor(target.clientHeight * 0.8)));
  return { top: target.scrollTop, height: target.scrollHeight, client: target.clientHeight };
}

// PURE — folds one harvest into the accumulated row map. Keyed by idAttr/href so rows keep their
// identity as the virtualized list re-renders; an index-keyed placeholder is replaced once a
// real-keyed row hydrates at that index. Returns how many rows were added or upgraded (0 → no
// growth).
export function mergeCardRows(byKey, rows) {
  let grew = 0;
  for (const row of rows) {
    // href keys use only the path — LinkedIn re-renders can vary tracking params per round,
    // which would make the same card look new every harvest and defeat the stable-rounds exit.
    const key = row.idAttr || (row.href && row.href.split("?")[0]) || `idx:${row.index}`;
    if (key !== `idx:${row.index}`) byKey.delete(`idx:${row.index}`); // placeholder hydrated
    const prev = byKey.get(key);
    if (prev && (prev.title || !row.title)) continue; // known and not an upgrade
    byKey.set(key, row);
    grew++;
  }
  return grew;
}

// Scroll-and-harvest rounds under one wall-clock budget (maxMs; omitted → uncapped). Each round:
// harvest all cards in one evaluate, merge, then scroll one step. Stops on: budget expiry (warn +
// return partial — same skip-and-continue convention as the rest of this file), end signal seen
// with nothing new, bottom reached with no growth for stableRounds rounds (scrolling continues
// until the bottom even through stale mid-list rounds, so append-on-bottom loaders still fire and
// a growing scrollHeight un-sets the bottom), maxRounds, or a wedged/deadline-exceeded CDP call.
export async function collectCards(page, cfg, { maxMs, evalTimeoutMs = DEFAULT_CALL_TIMEOUT_MS, maxRounds = 30, stableRounds = 3, roundDelayMs = 400, log = console } = {}) {
  const budget = createBudget(maxMs ?? Infinity);
  const byKey = new Map();
  let stale = 0;
  let atBottom = false;
  let endSeen = false;
  let lastDomCount = 0;
  for (let round = 0; round < maxRounds; round++) {
    // Expiry is checked before rounds > 0 (round 0 always harvests, so an expired budget still
    // yields whatever is on screen); the per-call deadline keeps a ≥1s floor so a nearly-spent
    // budget doesn't dispatch a doomed harvest.
    if (round > 0 && budget.expired()) {
      log.warn(`⚠ collectCards: hit ${maxMs}ms cap after ${byKey.size}/${lastDomCount} cards — proceeding with what was collected`);
      break;
    }
    const deadline = Math.min(evalTimeoutMs, Math.max(1000, budget.remaining()));
    let harvest;
    try {
      harvest = await withTimeout(page.evaluate(collectCardsInPage, cfg), deadline, "collectCards harvest");
    } catch (e) {
      log.warn(`⚠ collectCards: harvest failed (${e.message}) — proceeding with ${byKey.size} card(s)`);
      break;
    }
    const grew = mergeCardRows(byKey, harvest.rows) > 0;
    endSeen = endSeen || harvest.end;
    lastDomCount = harvest.rows.length;
    stale = grew ? 0 : stale + 1;
    if (endSeen && stale >= 1) break;
    if (atBottom && stale >= stableRounds) break;
    try {
      const s = await withTimeout(page.evaluate(scrollStepInPage, cfg.scroll_container || null), deadline, "collectCards scroll");
      atBottom = s.top + s.client >= s.height - 2;
    } catch (e) {
      log.warn(`⚠ collectCards: scroll failed (${e.message}) — proceeding with ${byKey.size} card(s)`);
      break;
    }
    await sleep(roundDelayMs);
  }
  // Hydrated harvest rows → the card shape the rest of the pipeline consumes.
  const base = page.url();
  return [...byKey.values()].map((row) => {
    let idAttr = row.idAttr;
    if (idAttr && cfg.job_card_id_attr_prefix && idAttr.startsWith(cfg.job_card_id_attr_prefix)) {
      idAttr = idAttr.slice(cfg.job_card_id_attr_prefix.length);
    }
    const job_id = idAttr || extractJobId(row.href);
    return {
      index: row.index,
      title: row.title,
      company: row.company,
      location: row.location,
      href: row.href,
      job_id,
      job_url: canonicalUrl(cfg, job_id, row.href, base),
    };
  });
}

// ---------- pagination ----------
// Loads all pages for a URL according to cfg.pagination_type:
//   "url-pages"      — iterates start=0, 25, 50… stopping when a page returns 0 cards or fewer
//                      than pagination_page_size (signals last page). Deduplicates by job_id.
//   "infinite-scroll" (or unset) — one load; collectCards' scroll rounds do the rest.
// Runs runAssertions on the first page load only. Options besides cardCap/log/jitterFn are
// forwarded verbatim to collectCards (maxMs, evalTimeoutMs, stableRounds, roundDelayMs).
export async function collectAllPages(page, url, cfg, { cardCap = 0, log = console, jitterFn = jitter, ...collectOpts } = {}) {
  const pType = (cfg.pagination_type || "infinite-scroll").trim();

  if (pType !== "url-pages") {
    await gotoWithRetry(page, url, { log });
    await jitterFn();
    await runAssertions(page, cfg);
    return collectCards(page, cfg, { log, ...collectOpts });
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
    await jitterFn();
    if (p === 0) await runAssertions(page, cfg);
    const cards = await collectCards(page, cfg, { log, ...collectOpts });
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
