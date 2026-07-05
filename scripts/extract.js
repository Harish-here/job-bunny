// scripts/extract.js — config-driven Playwright-over-CDP extractor (daily runner).
// Attaches to your ALREADY-RUNNING Chrome via CDP (--remote-debugging-port=9222) — never
// launches a browser, never re-logs-in. Reads selectors/behavior from page_inventory/<page>.md
// AT RUNTIME (config-driven; no codegen). DOM drift is fixed by editing the inventory.
//
// Pipeline: search_urls.md → [per page-group] scroll + collect cards → Stage A avoid-drop on
// card data (before JDs) → open each JD (inline | new-page) → capture raw text →
// append { job_url, source_query_url, raw_text, date_found } to jobs_raw_text.json.
//
// Quality gate: assertions from the inventory. On a page-group failure, skip THAT group and
// continue the others; record it in the run summary (one stale selector never kills the run).

import "dotenv/config";
import { readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { extractJobId } from "./util.js";
import { loadAvoid, isAvoided } from "./avoid.js";
import { readCache } from "./cache.js";
import { filterByTitle } from "./title_filter.js";
import { ROOT, paths, resolveProfileName } from "./config.js";

// Defaults to the profile's search_urls.md; SEARCH_URLS_FILE overrides it for subset/test runs.
const SEARCH_URLS = process.env.SEARCH_URLS_FILE || paths().searchUrls;
const OUT = paths().jobsRawText;
const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:9222";
const DEBUG = !!process.env.DEBUG;
const CARD_CAP = parseInt(process.env.EXTRACT_MAX_CARDS || "0", 10);

// One-off widen of the f_TPR search window (e.g. a missed daily run) without touching
// search_urls.md — only rewrites relative windows (r<sec>); absolute anchors (a<epoch>) are a
// different, already-handled case in add_url.js and are left alone.
function applyWindowOverride(url) {
  const hours = parseInt(process.env.JOBBUNNY_WINDOW_HOURS || "0", 10);
  if (!hours) return url;
  const u = new URL(url);
  if (!/^r\d+/.test(u.searchParams.get("f_TPR") || "")) return url;
  u.searchParams.set("f_TPR", `r${hours * 3600}`);
  return u.toString();
}

const exists = (p) => access(p, constants.F_OK).then(() => true).catch(() => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(2000 + Math.floor(Math.random() * 3000)); // 2–5s
const today = () => new Date().toISOString().slice(0, 10);

// ---------- search_urls.md (hierarchical Channel → page → labeled URLs) ----------
export function parseSearchUrls(text) {
  const groups = new Map(); // page → { channel, page, inventory, urls: [{label, url}] }
  let channel = null;
  let page = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^##\s+(.+)$/))) {
      channel = m[1].trim();
      page = null;
    } else if ((m = line.match(/^###\s+(.+)$/))) {
      page = m[1].trim();
      if (!groups.has(page)) {
        groups.set(page, { channel, page, inventory: `page_inventory/${page}.md`, urls: [] });
      }
    } else if ((m = line.match(/^<!--\s*inventory:\s*(.+?)\s*-->$/)) && page) {
      groups.get(page).inventory = m[1].trim();
    } else if ((m = line.match(/^[•*-]\s+(.+?)\s+-\s+(https?:\/\/\S+)$/)) && page) {
      groups.get(page).urls.push({ label: m[1].trim(), url: m[2].trim() });
    }
  }
  return [...groups.values()].filter((g) => g.urls.length > 0);
}

// ---------- page_inventory/<page>.md (key: value under sections) ----------
export function parseInventory(text) {
  const cfg = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^[-*]\s+([a-z_]+):\s*(.*)$/i);
    if (m) cfg[m[1].trim()] = m[2].trim();
  }
  return cfg;
}

// job_card_href is optional — pages that provide job IDs via job_card_id_attr + url_pattern_of_job
// don't need a link selector on the card itself.
const REQUIRED_SELECTORS = ["job_card", "job_card_title", "job_card_company", "jd_body"];

function validateInventory(cfg, page) {
  const missing = REQUIRED_SELECTORS.filter((k) => !cfg[k]);
  if (missing.length) {
    throw new Error(
      `inventory for "${page}" is missing/blank selector(s): ${missing.join(", ")}. ` +
        `Run /page-analyse to fill page_inventory/${page}.md.`
    );
  }
}

// ---------- scrolling ----------
async function scrollToEnd(page, cfg) {
  const endSel = cfg.end_of_results_signal;
  const scrollSel = cfg.scroll_container;
  const maxRounds = 40;
  let stable = 0;
  let lastCount = -1;
  for (let i = 0; i < maxRounds; i++) {
    if (endSel && (await page.locator(endSel).count())) break;
    await page.evaluate((sel) => {
      const el = sel ? document.querySelector(sel) : null;
      (el || document.scrollingElement || document.body).scrollBy(0, 100000);
    }, scrollSel || null);
    await sleep(800);
    const count = await page.locator(cfg.job_card).count();
    if (count === lastCount) {
      if (++stable >= 3) break; // no growth for 3 rounds → done
    } else {
      stable = 0;
      lastCount = count;
    }
  }
}

// ---------- card collection ----------
// Builds a canonical job_url from url_pattern_of_job (<id> placeholder) when available, so we
// store a clean URL instead of the tracking-laden href.
function canonicalUrl(cfg, id, href, base) {
  if (id && cfg.url_pattern_of_job && cfg.url_pattern_of_job.includes("<id>")) {
    return cfg.url_pattern_of_job.replace("<id>", id);
  }
  return href ? new URL(href, base).toString() : null;
}

async function collectCards(page, cfg) {
  const cards = page.locator(cfg.job_card);
  const n = await cards.count();
  const out = [];
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    // Lazy-rendered lists (e.g. LinkedIn) only populate a card's inner DOM once it's on screen.
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(120);
    // Supports ":nth(N)" suffix for pages where sibling selectors aren't usable (hashed classes).
    // e.g. "p:nth(1)" → card.locator("p").nth(1)
    const text = async (sel) => {
      if (!sel) return "";
      const m = sel.match(/:nth\((\d+)\)$/);
      const locator = m ? card.locator(sel.slice(0, -m[0].length)).nth(parseInt(m[1], 10)) : card.locator(sel).first();
      // Card fields (title/company/location) are always single-line. Take the first non-empty line
      // so that badge text or a11y duplicate spans embedded in the same element don't pollute the value.
      const raw = (await locator.innerText().catch(() => ""))?.trim() ?? "";
      return raw.split("\n").find((l) => l.trim()) ?? "";
    };
    const [title, company, location, href, idAttr_raw] = await Promise.all([
      text(cfg.job_card_title),
      text(cfg.job_card_company),
      text(cfg.job_card_location),
      cfg.job_card_href
        ? card.locator(cfg.job_card_href).first().getAttribute("href").catch(() => null)
        : Promise.resolve(null),
      cfg.job_card_id_attr
        ? card.getAttribute(cfg.job_card_id_attr).catch(() => null)
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

// ---------- assertions ----------
async function runAssertions(page, cfg) {
  const mustExist = parseList(cfg.must_exist);
  for (const sel of mustExist) {
    if (!(await page.locator(sel).count())) throw new Error(`assertion failed: must_exist selector not found: ${sel}`);
  }
  const minCards = parseInt(cfg.min_job_cards || "1", 10);
  const count = await page.locator(cfg.job_card).count();
  if (count < minCards) throw new Error(`assertion failed: ${count} cards < min_job_cards ${minCards}`);
}

function parseList(v) {
  if (!v) return [];
  return v.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

// ---------- pre-JD card filter ----------
// Applies a predicate, logs the drop count via msgFn(n), and accumulates into summary[summaryKey].
function stageFilter(cards, pred, msgFn, summaryKey, summary) {
  const before = cards.length;
  const out = cards.filter(pred);
  const n = before - out.length;
  if (summaryKey) summary[summaryKey] += n;
  if (n) console.log(msgFn(n));
  return out;
}

// ---------- JD capture ----------
async function waitSettled(page, cfg) {
  switch ((cfg.jd_settled_signal || "selector-visible").trim()) {
    case "network-idle":
      // Cap the wait — LinkedIn's long-poll/websocket traffic means networkidle often never
      // fires, which would otherwise hang ~30s (default timeout) per JD.
      await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
      break;
    case "url-change":
      await sleep(800);
      break;
    default:
      if (cfg.jd_body) await page.locator(cfg.jd_body).first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  }
}

// Extract JD text robustly: try the configured selector first; if empty (e.g. the direct-nav
// job page uses hashed class names), fall back to the smallest container whose text starts with
// jd_anchor_text ("About the job"). Anchor text is stable across LinkedIn's CSS churn.
async function extractJdText(target, cfg) {
  if (cfg.jd_body) {
    const t = ((await target.locator(cfg.jd_body).first().innerText().catch(() => "")) || "").trim();
    if (t) return t;
  }
  const anchor = cfg.jd_anchor_text || "About the job";
  return (
    await target
      .evaluate((a) => {
        const els = [...document.querySelectorAll("section,div,article,main")];
        // Tightest container that starts with the anchor AND holds real content (>=200 chars) —
        // skips the bare "About the job" heading and avoids grabbing the whole page wrapper.
        const m = els
          .filter((e) => {
            const t = (e.innerText || "").trim();
            return t.startsWith(a) && t.length >= 200;
          })
          .sort((x, y) => x.innerText.length - y.innerText.length)[0];
        return m ? m.innerText.trim() : "";
      }, anchor)
      .catch(() => "")
  );
}

// Token efficiency: cap stored JD length (JD_MAX_CHARS env or max_raw_text_chars in inventory,
// default 2500). The first ~2500 chars reliably carry title/seniority/skills/YoE/location; the
// rest is boilerplate (benefits, EEO, "about company") that just inflates the structuring step.
function jdCap(cfg) {
  return parseInt(process.env.JD_MAX_CHARS || cfg.max_raw_text_chars || "2500", 10);
}

// jdTab is a single REUSED tab for the new-page model — we goto() into it per job rather than
// opening/closing a fresh tab each time. Rapid newPage/close churn was destabilizing the shared
// CDP browser; one long-lived tab is far more reliable.
async function captureJd(jdTab, page, cfg, card, cap) {
  if ((cfg.interaction_model || "inline").trim() === "new-page") {
    await jdTab.goto(card.job_url || card.href, { waitUntil: "domcontentloaded" });
    await waitSettled(jdTab, cfg);
    let t = await extractJdText(jdTab, cfg);
    if (!t) {
      await jdTab.waitForTimeout(1800);
      t = await extractJdText(jdTab, cfg);
    }
    return t.slice(0, cap);
  }
  // inline: clicking the card renders the JD in a side panel on the same page
  await page.locator(cfg.job_card).nth(card.index).click();
  await waitSettled(page, cfg);
  return (await extractJdText(page, cfg)).slice(0, cap);
}

// ---------- pagination ----------
// Loads all pages for a URL according to cfg.pagination_type:
//   "url-pages"      — iterates start=0, 25, 50… stopping when a page returns 0 cards or fewer
//                      than pagination_page_size (signals last page). Deduplicates by job_id.
//   "infinite-scroll" (or unset) — existing scroll-and-stabilise behaviour.
// Runs runAssertions on the first page load only.
async function collectAllPages(page, url, cfg) {
  const pType = (cfg.pagination_type || "infinite-scroll").trim();

  if (pType !== "url-pages") {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await jitter();
    await scrollToEnd(page, cfg);
    await runAssertions(page, cfg);
    return collectCards(page, cfg);
  }

  const param    = cfg.pagination_param    || "start";
  const pageSize = parseInt(cfg.pagination_page_size || "25", 10);
  const maxPages = parseInt(cfg.max_pages  || "4", 10);
  // Honour CARD_CAP early — stop fetching pages once we have enough cards,
  // rather than fetching all max_pages and capping afterwards.
  const cardCap  = CARD_CAP;
  const seen = new Set();
  const all  = [];

  for (let p = 0; p < maxPages; p++) {
    const u = new URL(url);
    u.searchParams.set(param, p * pageSize);
    await page.goto(u.toString(), { waitUntil: "domcontentloaded" });
    await jitter();
    if (p === 0) await runAssertions(page, cfg);
    const cards = await collectCards(page, cfg);
    // Warn on page 2+ returning nothing — could be selector drift rather than a real last page.
    if (p > 0 && cards.length === 0) {
      console.warn(`[extract]   ⚠ page ${p + 1} returned 0 cards — possible selector drift`);
    }
    // Iterate (not filter+forEach) so seen is updated per-card — prevents same-page duplicates
    // from both passing the filter before the Set is updated.
    const prevLen = all.length;
    for (const card of cards) {
      if (!card.job_id || seen.has(card.job_id)) continue;
      seen.add(card.job_id);
      all.push(card);
    }
    console.log(`[extract]   page ${p + 1}: ${cards.length} cards (${all.length - prevLen} new)`);
    if (cards.length === 0 || cards.length < pageSize) break;
    if (cardCap > 0 && all.length >= cardCap) break;
  }
  return all;
}

// ---------- main ----------
async function main() {
  console.log(`[extract] profile=${resolveProfileName()}`);
  if (!(await exists(SEARCH_URLS))) throw new Error(`${SEARCH_URLS} not found — run /setup.`);
  const groups = parseSearchUrls(await readFile(SEARCH_URLS, "utf8"));
  if (!groups.length) throw new Error("No search URLs found in search_urls.md (run /add-url).");

  const [avoid, cache] = await Promise.all([loadAvoid(), readCache()]);
  const cachedIds = new Set((cache.jobs || []).map((j) => j.job_id).filter(Boolean));
  console.log(`[extract] cache: ${cachedIds.size} known job IDs (last_run: ${cache.last_run ?? "never"}) — will skip`);

  let browser = await chromium.connectOverCDP(CDP_URL);
  let context = browser.contexts()[0] || (await browser.newContext());

  // When LinkedIn closes our tab the whole context can die. Reconnect to CDP transparently.
  async function newPage() {
    try {
      return await context.newPage();
    } catch (e) {
      if (!/closed/i.test(e.message)) throw e;
      console.warn("[extract]   context lost — reconnecting to CDP...");
      browser = await chromium.connectOverCDP(CDP_URL);
      context = browser.contexts()[0] || (await browser.newContext());
      return context.newPage();
    }
  }

  const results = [];
  const seenJobIdsThisRun = new Set();
  const summary = { groups: 0, skipped: [], cards: 0, avoided: 0, cache_skipped: 0, run_deduped: 0, title_dropped: 0, captured: 0 };

  for (const group of groups) {
    summary.groups++;
    const invPath = join(ROOT, group.inventory);
    let cfg;
    try {
      if (!(await exists(invPath))) throw new Error(`no inventory at ${group.inventory} (run /page-analyse)`);
      cfg = parseInventory(await readFile(invPath, "utf8"));
      validateInventory(cfg, group.page);
    } catch (err) {
      console.error(`[extract] SKIP group "${group.page}" — ${err.message}`);
      summary.skipped.push({ page: group.page, reason: err.message });
      continue;
    }

    let page = await newPage();
    const isNewPage = (cfg.interaction_model || "inline").trim() === "new-page";
    let jdTab = isNewPage ? await newPage() : null;
    const groupCap = jdCap(cfg);
    for (const { url: rawUrl } of group.urls) {
      // Per-URL resilience: a failure on one search (or a closed tab from outside interaction)
      // skips just that URL, never the rest of the group.
      const url = applyWindowOverride(rawUrl);
      try {
        if (page.isClosed()) page = await newPage();
        console.log(`[extract] ${group.page} ← ${url}`);
        let cards = await collectAllPages(page, url, cfg);

        cards = stageFilter(cards,
          (c) => !isAvoided(c.company, avoid),
          (n) => `[extract]   Stage A: dropped ${n} avoid-list card(s) pre-JD`,
          "avoided", summary);

        cards = stageFilter(cards,
          (c) => !c.job_id || !cachedIds.has(c.job_id),
          (n) => `[extract]   cache: skipped ${n} already-known card(s)`,
          "cache_skipped", summary);

        cards = stageFilter(cards,
          (c) => {
            if (!c.job_id) return true;
            if (seenJobIdsThisRun.has(c.job_id)) return false;
            seenJobIdsThisRun.add(c.job_id);
            return true;
          },
          (n) => `[extract]   run-dedup: dropped ${n} duplicate card(s) (already captured from an earlier search URL this run)`,
          "run_deduped", summary);

        cards = stageFilter(cards,
          (c) => {
            const r = filterByTitle(c.title || "");
            if (!r.pass && DEBUG) console.log(`[title-filter] DROP — ${r.reason} — ${c.title}`);
            return r.pass;
          },
          (n) => `[extract]   title-filter: dropped ${n} card(s) pre-JD`,
          "title_dropped", summary);

        // Cap applied after all pre-filters so it limits genuinely-new JD-fetch candidates.
        if (CARD_CAP > 0 && cards.length > CARD_CAP) cards = cards.slice(0, CARD_CAP);

        summary.cards += cards.length; // cards entering JD fetch (post all filters)

        for (const card of cards) {
          if (!card.job_url) continue;
          await jitter();
          let raw_text;
          try {
            if (isNewPage && jdTab.isClosed()) jdTab = await newPage();
            raw_text = await captureJd(jdTab, page, cfg, card, groupCap);
          } catch (e) {
            console.error(`[extract]   skip card ${card.job_id} — ${e.message}`);
            continue; // one bad JD never aborts the rest
          }
          if (!raw_text) continue;
          // Carry the card's clean title/company/location alongside raw_text — the structurer
          // needs them when a JD body doesn't restate location/title.
          results.push({
            job_url: card.job_url,
            source_query_url: url,
            raw_text,
            date_found: today(),
            job_id: card.job_id,
            card_title: card.title,
            card_company: card.company,
            card_location: card.location,
          });
          summary.captured++;
        }
      } catch (err) {
        console.error(`[extract] SKIP url (${group.page}) — ${err.message}`);
        summary.skipped.push({ page: group.page, url, reason: err.message });
      }
      // Incremental flush after each URL — a kill mid-run keeps everything captured so far.
      await writeFile(OUT, JSON.stringify(results, null, 2) + "\n");
    }
    await page.close().catch(() => {});
    if (jdTab) await jdTab.close().catch(() => {});
  }

  // NOTE: never browser.close() — this is an attach over CDP to the user's running Chrome;
  // closing it would tear down their browser/session. We just drop the connection on exit.

  console.log(
    `[extract] groups=${summary.groups} skipped=${summary.skipped.length} ` +
      `cards=${summary.cards} avoided=${summary.avoided} cache_skipped=${summary.cache_skipped} ` +
      `run_deduped=${summary.run_deduped} title_dropped=${summary.title_dropped} captured=${summary.captured} → jobs_raw_text.json`
  );
  for (const s of summary.skipped) console.log(`[extract]   skipped ${s.page}: ${s.reason}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0)) // drop the CDP connection without closing the user's browser
    .catch((err) => {
      console.error(`[extract] FAILED: ${err.message}`);
      process.exit(1);
    });
}
