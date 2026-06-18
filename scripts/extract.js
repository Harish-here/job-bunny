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

import { readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { extractJobId } from "./util.js";
import { loadAvoid, isAvoided } from "./avoid.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH_URLS = join(ROOT, "search_urls.md");
const OUT = join(ROOT, "jobs_raw_text.json");
const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:9222";

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

const REQUIRED_SELECTORS = ["job_card", "job_card_title", "job_card_company", "job_card_href", "jd_body"];

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
async function collectCards(page, cfg) {
  const cards = page.locator(cfg.job_card);
  const n = await cards.count();
  const out = [];
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    const text = async (sel) => (sel ? (await card.locator(sel).first().textContent().catch(() => ""))?.trim() ?? "" : "");
    const href = await card.locator(cfg.job_card_href).first().getAttribute("href").catch(() => null);
    out.push({
      index: i,
      title: await text(cfg.job_card_title),
      company: await text(cfg.job_card_company),
      location: await text(cfg.job_card_location),
      href: href ? new URL(href, page.url()).toString() : null,
    });
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

// ---------- JD capture ----------
async function waitSettled(page, cfg) {
  switch ((cfg.jd_settled_signal || "selector-visible").trim()) {
    case "network-idle":
      await page.waitForLoadState("networkidle").catch(() => {});
      break;
    case "url-change":
      await sleep(800);
      break;
    case "selector-visible":
    default:
      if (cfg.jd_body) await page.locator(cfg.jd_body).first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  }
}

async function captureJd(context, page, cfg, card) {
  if ((cfg.interaction_model || "inline").trim() === "new-page") {
    const jdPage = await context.newPage();
    try {
      await jdPage.goto(card.href, { waitUntil: "domcontentloaded" });
      await waitSettled(jdPage, cfg);
      return (await jdPage.locator(cfg.jd_body).first().innerText().catch(() => "")).trim();
    } finally {
      await jdPage.close();
    }
  }
  // inline: clicking the card renders the JD in a side panel on the same page
  await page.locator(cfg.job_card).nth(card.index).click();
  await waitSettled(page, cfg);
  return (await page.locator(cfg.jd_body).first().innerText().catch(() => "")).trim();
}

// ---------- main ----------
async function main() {
  if (!(await exists(SEARCH_URLS))) throw new Error(`${SEARCH_URLS} not found — run /setup.`);
  const groups = parseSearchUrls(await readFile(SEARCH_URLS, "utf8"));
  if (!groups.length) throw new Error("No search URLs found in search_urls.md (run /add-url).");

  const avoid = await loadAvoid();
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] || (await browser.newContext());

  const results = [];
  const summary = { groups: 0, skipped: [], cards: 0, avoided: 0, captured: 0 };

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

    const page = await context.newPage();
    try {
      for (const { url } of group.urls) {
        console.log(`[extract] ${group.page} ← ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await jitter();
        await scrollToEnd(page, cfg);
        await runAssertions(page, cfg); // throws → skip whole group

        let cards = await collectCards(page, cfg);
        summary.cards += cards.length;
        const before = cards.length;
        cards = cards.filter((c) => !isAvoided(c.company, avoid));
        const dropped = before - cards.length;
        summary.avoided += dropped;
        if (dropped) console.log(`[extract]   Stage A: dropped ${dropped} avoid-list card(s) pre-JD`);

        for (const card of cards) {
          if (!card.href) continue;
          await jitter();
          const raw_text = await captureJd(context, page, cfg, card);
          if (!raw_text) continue;
          results.push({
            job_url: card.href,
            source_query_url: url,
            raw_text,
            date_found: today(),
            job_id: extractJobId(card.href),
          });
          summary.captured++;
        }
      }
    } catch (err) {
      console.error(`[extract] SKIP group "${group.page}" — ${err.message}`);
      summary.skipped.push({ page: group.page, reason: err.message });
    } finally {
      await page.close().catch(() => {});
    }
  }

  await browser.close().catch(() => {});
  await writeFile(OUT, JSON.stringify(results, null, 2) + "\n");

  console.log(
    `[extract] groups=${summary.groups} skipped=${summary.skipped.length} ` +
      `cards=${summary.cards} avoided=${summary.avoided} captured=${summary.captured} → jobs_raw_text.json`
  );
  for (const s of summary.skipped) console.log(`[extract]   skipped ${s.page}: ${s.reason}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[extract] FAILED: ${err.message}`);
    process.exit(1);
  });
}
