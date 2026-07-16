// scripts/pipeline/extract.js — thin orchestrator over scripts/pipeline/extract/{parse,state,
// filters,cards,jd}.js and scripts/lib/{browser,run_log,page_actions}.js. Reads selectors/behavior
// from page_inventory/<page>.md AT RUNTIME (config-driven; no codegen) — DOM drift is a config
// fix, never a code fix here.
//
// Chrome lifecycle: extract now OWNS Chrome end-to-end. ensureChrome() (scripts/lib/browser.js)
// launches it over CDP (--remote-debugging-port=9222) if it isn't already running; teardown()
// ALWAYS kills it on every exit path (success, error, SIGINT/SIGTERM) unless
// JOBBUNNY_KEEP_BROWSER=1. Login persists on disk in .chrome-debug/, so killing is free — the
// next run (or /doctor) just relaunches against the same user-data-dir.
//
// Pipeline: search_urls.md → [per page-group] scroll + collect cards → Stage A avoid-drop on
// card data (before JDs) → open each JD (inline | new-page) → capture raw text → append
// { job_url, source_query_url, raw_text, date_found, job_id, card_title, card_company,
// card_location } to jobs_raw_text.json. Skip-and-continue: a page-group failure skips THAT
// group; a URL failure skips just that URL — recorded in the run summary (one stale selector
// never kills the run).
//
// Resume: data/extract_resume.json tracks URLs completed today (post-applyWindowOverride key) —
// a same-day rerun skips them; JOBBUNNY_FRESH=1 forces a clean run. A URL is only marked done
// after its incremental results flush succeeds.
//
// Heartbeat: data/extract_progress.json is rewritten at every checkpoint (best-effort — a write
// failure never kills the run) so run_scheduled.sh's watchdog can detect a mid-run stall, not
// just a never-started process.

import "dotenv/config";
import { readFile, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isMain } from "../lib/cli.js";
import { loadAvoid } from "./avoid.js";
import { readCache } from "../notion/cache.js";
import { ROOT, paths, resolveProfileName } from "../lib/config.js";
import { notify } from "../notify/notify.js";
import { writeJson } from "../lib/io.js";
import { ensureChrome, killChrome, createSession } from "../lib/browser.js";
import { jitter } from "../lib/page_actions.js";
import { createRunLog } from "../lib/run_log.js";
import { parseSearchUrls, parseInventory, validateInventory, applyWindowOverride } from "./extract/parse.js";
import {
  computeAggregateFailure,
  shouldResetResume,
  newResume,
  isUrlCompleted,
  markUrlDone,
  mergeResults,
  buildProgress,
} from "./extract/state.js";
import { applyCardGates } from "./extract/filters.js";
import { collectAllPages } from "./extract/cards.js";
import { jdCap, captureJd } from "./extract/jd.js";

// Defaults to the profile's search_urls.md; SEARCH_URLS_FILE overrides it for subset/test runs.
const SEARCH_URLS = process.env.SEARCH_URLS_FILE || paths().searchUrls;
const OUT = paths().jobsRawText;
const DEBUG = !!process.env.DEBUG;
const CARD_CAP = parseInt(process.env.EXTRACT_MAX_CARDS || "0", 10);
const COLLECT_CARDS_MAX_MS = parseInt(process.env.EXTRACT_COLLECT_CARDS_MAX_MS || "120000", 10);
const KEEP_BROWSER = process.env.JOBBUNNY_KEEP_BROWSER === "1";
const FRESH = process.env.JOBBUNNY_FRESH === "1";

const exists = (p) => access(p, constants.F_OK).then(() => true).catch(() => false);
const today = () => new Date().toISOString().slice(0, 10);

// Module-scope refs the signal handlers / teardown need.
let session = null;
let log = null;
let lastStage = "starting";
let teardownDone = false;

// Written as the very first thing main() does — lets run_scheduled.sh's watchdog confirm
// extract actually started, instead of only finding out via the full-run timeout.
async function markStarted() {
  const dataDir = paths().dataDir;
  await mkdir(dataDir, { recursive: true });
  await writeJson(paths().extractStarted, { timestamp: new Date().toISOString() });
}

// ---------- main ----------
async function main() {
  await markStarted();

  const runStartedAt = new Date().toISOString();
  const progressState = { group: null, urlIndex: null, urlTotal: null, url: null, cardsCaptured: 0 };
  let progressFinal = false;
  async function writeProgress(stage, done = false) {
    if (progressFinal) return; // done:true is terminal — teardown's checkpoint must not clobber it
    if (done) progressFinal = true;
    lastStage = stage;
    const p = buildProgress({
      pid: process.pid,
      runStartedAt,
      stage,
      group: progressState.group,
      urlIndex: progressState.urlIndex,
      urlTotal: progressState.urlTotal,
      url: progressState.url,
      cardsCaptured: progressState.cardsCaptured,
      done,
    });
    await writeJson(paths().extractProgress, p).catch(() => {}); // heartbeat is best-effort, never kills the run
  }

  await mkdir(paths().extractLogDir, { recursive: true });
  const logFile = join(paths().extractLogDir, `extract_${runStartedAt.replace(/[:.]/g, "-")}.log`);
  log = createRunLog({ tag: "extract", filePath: logFile, onCheckpoint: (stage) => writeProgress(stage) });

  const consoleLike = { log: (m) => log.info(m), warn: (m) => log.warn(m) };

  await log.checkpoint("starting");
  log.info(`profile=${resolveProfileName()}`);

  if (!(await exists(SEARCH_URLS))) throw new Error(`${SEARCH_URLS} not found — run /setup.`);
  const searchUrlsText = await readFile(SEARCH_URLS, "utf8"); // also feeds parseSearchUrls
  const groups = parseSearchUrls(searchUrlsText);
  if (!groups.length) throw new Error("No search URLs found in search_urls.md (run /add-url).");
  await log.checkpoint("parse-config", { groups: groups.length });

  const [avoid, cache] = await Promise.all([loadAvoid(), readCache()]);
  const cachedIds = new Set((cache.jobs || []).map((j) => j.job_id).filter(Boolean));
  log.info(`cache: ${cachedIds.size} known job IDs (last_run: ${cache.last_run ?? "never"}) — will skip`);

  // ---------- resume (data/extract_resume.json) ----------
  const searchUrlsHash = "sha256:" + createHash("sha256").update(searchUrlsText).digest("hex");
  const windowHours = parseInt(process.env.JOBBUNNY_WINDOW_HOURS || "0", 10);
  let resume = null;
  try { resume = JSON.parse(await readFile(paths().extractResume, "utf8")); } catch {}
  let { reset, reason } = shouldResetResume(resume, { today: today(), fresh: FRESH, searchUrlsHash, windowHours });
  let results = [];
  if (!reset) {
    try {
      results = mergeResults(JSON.parse(await readFile(OUT, "utf8")), []);
    } catch {
      if (resume.completed.length > 0) {
        // resume claims completed URLs but their flushed output is gone (truncated write,
        // manual delete) — trusting it would silently drop those records for the day.
        reset = true;
        reason = "output-missing";
      }
    }
  }
  if (reset) {
    resume = newResume({ today: today(), searchUrlsHash, windowHours });
    results = [];
    log.info(`resume: starting fresh (${reason})`);
  } else {
    log.info(`resume: continuing — ${resume.completed.length} URL(s) already completed today`);
  }
  const seenJobIdsThisRun = new Set(results.map((r) => r.job_id).filter(Boolean));
  // Pre-seeded from prior captures — see extract/filters.js for why companiesSeen is captured
  // ahead of the cache/title gates.
  const companiesSeen = new Set(results.map((r) => r.card_company).filter(Boolean).map((c) => c.trim()));
  if (!reset) {
    // Recover companies whose cards were title/cache-dropped on already-completed URLs —
    // they're in companies_seen.json from the earlier run but not in the captured results.
    try {
      for (const c of JSON.parse(await readFile(paths().companiesSeen, "utf8"))) companiesSeen.add(c);
    } catch {}
  }
  async function flushResume() {
    await writeJson(paths().extractResume, resume);
  }
  if (reset) {
    await flushResume();
    // Truncate yesterday's output NOW — if this run dies before its first per-URL flush, a
    // same-day rerun (non-reset) would otherwise seed results (and companies) from the prior
    // day's files.
    await writeJson(OUT, results);
    await writeJson(paths().companiesSeen, [...companiesSeen].sort());
  }

  // ---------- Chrome + CDP session ----------
  await log.checkpoint("connect-cdp");
  await ensureChrome({ log: console });
  session = createSession({ log: console }); // NEVER browser.close() over CDP — see browser.js

  const summary = { groups: 0, skipped: [], cards: 0, avoided: 0, cache_skipped: 0, run_deduped: 0, title_dropped: 0, captured: 0, resumed_skipped: 0 };

  for (const group of groups) {
    summary.groups++;
    const invPath = join(ROOT, group.inventory);
    let cfg;
    try {
      if (!(await exists(invPath))) throw new Error(`no inventory at ${group.inventory} (run /page-analyse)`);
      cfg = parseInventory(await readFile(invPath, "utf8"));
      validateInventory(cfg, group.page);
    } catch (err) {
      log.error(`SKIP group "${group.page}" — ${err.message}`);
      summary.skipped.push({ page: group.page, reason: err.message });
      continue;
    }

    let page = await session.openTab();
    const isNewPage = (cfg.interaction_model || "inline").trim() === "new-page";
    let jdTab = isNewPage ? await session.openTab() : null;
    const groupCap = jdCap(cfg);

    for (let ui = 0; ui < group.urls.length; ui++) {
      const rawUrl = group.urls[ui].url;
      const url = applyWindowOverride(rawUrl, windowHours);

      // Per-URL resume gate — a same-day rerun skips URLs already completed & flushed.
      if (isUrlCompleted(resume, url)) {
        summary.resumed_skipped++;
        log.info(`resume: skipping already-completed ${url}`);
        continue;
      }

      progressState.group = group.page;
      progressState.url = url;
      progressState.urlIndex = ui + 1;
      progressState.urlTotal = group.urls.length;
      await log.checkpoint("load-url", { group: group.page, url });

      let urlSucceeded = false;
      try {
        if (page.isClosed()) page = await session.openTab();
        log.info(`${group.page} ← ${url}`);
        let cards = await collectAllPages(page, url, cfg, {
          cardCap: CARD_CAP,
          collectCardsMaxMs: COLLECT_CARDS_MAX_MS,
          log: consoleLike,
        });
        await log.checkpoint("collect-cards", { cards: cards.length });

        await log.checkpoint("filter");
        cards = applyCardGates(cards, {
          avoid,
          cachedIds,
          seenIds: seenJobIdsThisRun,
          cardCap: CARD_CAP,
          debug: DEBUG,
          summary,
          companiesSeen,
          log: consoleLike.log,
        });

        summary.cards += cards.length; // cards entering JD fetch (post all filters)

        for (const card of cards) {
          if (!card.job_url) continue;
          await jitter();
          let raw_text;
          try {
            if (isNewPage && jdTab.isClosed()) jdTab = await session.openTab();
            raw_text = await captureJd(jdTab, page, cfg, card, groupCap, { log: consoleLike });
          } catch (e) {
            log.error(`skip card ${card.job_id} — ${e.message}`);
            continue; // one bad JD never aborts the rest
          }
          if (!raw_text) continue;
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
          progressState.cardsCaptured++;
          if (progressState.cardsCaptured % 5 === 0) {
            await log.checkpoint("jd-capture", { captured: progressState.cardsCaptured });
          }
        }
        urlSucceeded = true;
      } catch (err) {
        log.error(`SKIP url (${group.page}) — ${err.message}`);
        summary.skipped.push({ page: group.page, url, reason: err.message });
      }

      // Incremental flush after each URL — a kill mid-run keeps everything captured so far.
      await writeJson(OUT, results);
      // companies_seen must persist at the same cadence as OUT — a killed run must not lose the
      // set (previously only written once, at the very end of main()).
      await writeJson(paths().companiesSeen, [...companiesSeen].sort());
      await log.checkpoint("flush", { url });
      // Completion is claimed only after the results flush above has succeeded.
      if (urlSucceeded) {
        resume = markUrlDone(resume, { page: group.page, url, finishedAt: new Date().toISOString() });
        await flushResume();
      }
    }

    await session.closeTab(page);
    if (jdTab) await session.closeTab(jdTab);
  }

  log.info(
    `groups=${summary.groups} skipped=${summary.skipped.length} resumed_skipped=${summary.resumed_skipped} ` +
      `cards=${summary.cards} avoided=${summary.avoided} cache_skipped=${summary.cache_skipped} ` +
      `run_deduped=${summary.run_deduped} title_dropped=${summary.title_dropped} captured=${summary.captured} ` +
      `companies_seen=${companiesSeen.size} → jobs_raw_text.json`
  );
  for (const s of summary.skipped) log.info(`skipped ${s.page}: ${s.reason}`);

  await checkAggregateFailure(groups, summary);
  await log.checkpoint("done");        // log line + a progress write at stage "done"
  await writeProgress("done", true);   // terminal heartbeat state — watchdog treats done:true as healthy forever
}

// Aggregate "every URL failed" detection (see computeAggregateFailure in extract/state.js for
// the group-vs-url skip semantics) → blocking notify. A stale/expired LinkedIn session tends to
// fail every group at once, not just one flaky selector.
async function checkAggregateFailure(groups, summary) {
  const { totalUrls, failedUrls, allFailed } = computeAggregateFailure(groups, summary);
  if (!allFailed) return;
  await notify({
    severity: "blocking",
    title: "Extract: every URL failed",
    body:
      `${failedUrls}/${totalUrls} URL(s) failed this run — shaped like a LinkedIn logout — ` +
      `check .chrome-debug/ session.`,
  });
}

// ---------- teardown ----------
// Always kills Chrome on the way out (success, error, or signal) unless JOBBUNNY_KEEP_BROWSER=1
// — see the header comment for why that's free.
async function teardown(reason, error = null) {
  if (teardownDone) return;
  teardownDone = true;
  try { await log?.checkpoint("teardown", { reason }); } catch {}
  if (KEEP_BROWSER) {
    // Leave Chrome running for post-mortem — just tidy our own tabs and detach.
    try { await session?.closeAllTabs(); } catch {}
    try { session?.disconnect(); } catch {}
    console.warn("[extract] JOBBUNNY_KEEP_BROWSER=1 — leaving Chrome running");
  } else {
    // killChrome takes every tab with it — no CDP round-trips that could hang on a wedged context.
    try { session?.disconnect(); } catch {}
    await killChrome({ log: console });
  }
  if (error) {
    await notify({
      severity: "blocking",
      title: "Extract: fatal error",
      body: `${error.message} (stage=${lastStage})`,
    }).catch(() => {});
  }
}

if (isMain(import.meta.url)) {
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      if (teardownDone) process.exit(sig === "SIGINT" ? 130 : 143);
      teardown(sig).finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
    });
  }
  main()
    .then(async () => {
      await teardown("success");
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`[extract] FAILED: ${err.message}`);
      await teardown("error", err);
      process.exit(1);
    });
}

// Backward-compatible re-exports — these now live in extract/{parse,state}.js.
export { parseSearchUrls, parseInventory } from "./extract/parse.js";
export { computeAggregateFailure } from "./extract/state.js";
