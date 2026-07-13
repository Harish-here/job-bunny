// scripts/ops/doctor.js — preflight for /run. Checks (no mutations):
//   1. Secrets present (.env has NOTION_TOKEN; profile.json has notion_db_id)
//   2. Greenhouse lane's greenhouse_boards.md (optional — absent = lane disabled, still a pass)
//   3. Chrome CDP reachable on :9222 (real LinkedIn session lives there)
//   4. Every page-type referenced in search_urls.md has a page_inventory/<page>.md
//   5. cache.json present & valid
// Exits non-zero if any check fails.

import "dotenv/config";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { ROOT, CHROME_BIN, paths, loadProfile, resolveProfileName } from "../lib/config.js";
import { homeLocations } from "../lib/util.js";
import { notify } from "../notify/notify.js";
import { telegramTokenEnvKey } from "../notify/telegram.js";

const P = paths();
const exists = (p) => access(p, constants.F_OK).then(() => true).catch(() => false);

let failed = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  console.log(`  ✗ ${m}`);
  failed++;
};

async function checkSecrets() {
  console.log("[doctor] secrets");
  if (process.env.NOTION_TOKEN) pass("NOTION_TOKEN set");
  else fail("NOTION_TOKEN missing (run /setup)");
  try {
    const { notion_db_id } = loadProfile();
    if (notion_db_id) pass("Notion DB id set");
    else fail("Notion DB id missing (run /setup)");
  } catch (err) {
    fail(err.message);
  }
}

// No live Telegram API reachability check here (deliberate, unlike checkCDP): doctor gates
// the whole pipeline, and a transient Telegram API blip must not hard-abort scraping/syncing
// for a reason unrelated to the pipeline itself.
async function checkNotifier() {
  console.log("[doctor] notifications");
  let telegram;
  try {
    telegram = loadProfile().notify?.telegram;
  } catch (err) {
    return fail(err.message);
  }
  if (!telegram?.enabled) {
    pass("Telegram notifications disabled (optional — run /notify-setup to enable)");
    return;
  }
  const perProfileKey = telegramTokenEnvKey(resolveProfileName());
  if (!process.env[perProfileKey] && !process.env.TELEGRAM_BOT_TOKEN) {
    fail(`TELEGRAM_BOT_TOKEN (or ${perProfileKey}) missing (run /notify-setup)`);
  } else {
    pass(process.env[perProfileKey] ? `${perProfileKey} set` : "TELEGRAM_BOT_TOKEN set (shared)");
  }
  if (!telegram.chat_id) fail("notify.telegram.chat_id missing in profile.json (run /notify-setup)");
  else pass("notify.telegram.chat_id set");
}

// No live Greenhouse Boards API reachability check here (deliberate, same rationale as
// checkNotifier): a transient API blip must not hard-abort the pipeline over an optional lane.
// This is a lenient structural check only — every non-blank, non-comment/heading line must
// match "- <name> - <token>".
async function checkGreenhouse() {
  console.log("[doctor] greenhouse lane");
  if (!(await exists(P.greenhouseBoards))) {
    pass("optional — greenhouse lane disabled (create greenhouse_boards.md to enable)");
    return;
  }
  const text = await readFile(P.greenhouseBoards, "utf8");
  let boards = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!/^-\s+.+\s+-\s+\S+$/.test(line)) {
      return fail(`greenhouse_boards.md malformed line: "${line}"`);
    }
    boards++;
  }
  pass(`greenhouse_boards.md valid (${boards} board(s))`);
}

async function checkProfileFiles() {
  console.log("[doctor] profile config");
  if (await exists(P.resumeMeta)) {
    try {
      const meta = JSON.parse(await readFile(P.resumeMeta, "utf8"));
      homeLocations(meta.location);
      pass("resume_meta.json present, location shape valid");
    } catch (err) {
      fail(`resume_meta.json present but invalid (${err.message}) — run /update-resume`);
    }
  } else {
    fail("resume_meta.json missing (fill resume.json, then run /update-resume)");
  }
  if (await exists(P.filterConfig)) pass("filter_config.json present");
  else fail("filter_config.json missing (run /setup)");
}

const CHROME_DATA_DIR = join(ROOT, ".chrome-debug");

async function cdpReachable() {
  try {
    const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// The debug Chrome instance is never restarted on its own — CDP-reachable used to be the
// only thing checkCDP verified. Left alone across days it just accumulates tabs/memory (found
// via a live incident: 3-day uptime, 80% swap used, 56 Chrome processes on an 8GB machine).
// Recycling past this age keeps the same on-disk profile/LinkedIn session intact — only the
// process restarts, never the user-data-dir — while capping how long any one instance lives.
const CHROME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function getChromePid() {
  try {
    const out = execFileSync("lsof", ["-ti", ":9222", "-sTCP:LISTEN"], { encoding: "utf8" }).trim();
    const pid = out.split("\n")[0];
    return pid ? Number(pid) : null;
  } catch {
    return null;
  }
}

// ps `etime` format: [[DD-]HH:]MM:SS
function parseEtimeToMs(etime) {
  let days = 0;
  let rest = etime.trim();
  if (rest.includes("-")) {
    const [d, r] = rest.split("-");
    days = Number(d);
    rest = r;
  }
  const parts = rest.split(":").map(Number);
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) [h, m, s] = parts;
  else if (parts.length === 2) [m, s] = parts;
  else if (parts.length === 1) [s] = parts;
  return (((days * 24 + h) * 60 + m) * 60 + s) * 1000;
}

function getProcessAgeMs(pid) {
  try {
    const etime = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return parseEtimeToMs(etime);
  } catch {
    return null;
  }
}

// Chrome opens its default "New Tab Page" whenever it's launched with no URL argument;
// extract.js never touches it (it only ever opens its own new pages), so it just sits there
// indefinitely. Closed over the same CDP attach path extract.js uses, following its documented
// rule: never browser.close() here — this attaches to the user's real, persistent Chrome, and
// closing the Browser object over CDP would take the whole process down with it.
async function closeBlankTabs() {
  try {
    const browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) return;
    for (const page of context.pages()) {
      // "chrome://newtab/" is what this Chrome version (verified live against a fresh
      // profile) actually reports for its default New Tab Page; "chrome://new-tab-page/"
      // is included defensively for other/future Chrome versions that resolve it there.
      if (
        page.url() === "about:blank" ||
        page.url() === "chrome://newtab/" ||
        page.url() === "chrome://new-tab-page/"
      ) {
        await page.close().catch(() => {});
      }
    }
  } catch {
    // best-effort cleanup only — never fail doctor over it
  }
}

async function launchChrome() {
  console.log("  … launching Chrome with debug profile");
  const child = spawn(CHROME_BIN, [
    "--remote-debugging-port=9222",
    `--user-data-dir=${CHROME_DATA_DIR}`,
  ], { detached: true, stdio: "ignore" });
  child.unref();

  // Poll for up to 10 s
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const v = await cdpReachable();
    if (v) {
      pass(`reachable (${v.Browser || "Chrome"}) — just launched`);
      await closeBlankTabs();
      return true;
    }
  }
  return false;
}

async function checkCDP() {
  console.log("[doctor] chrome CDP :9222");
  const v = await cdpReachable();
  if (v) {
    const pid = getChromePid();
    const ageMs = pid !== null ? getProcessAgeMs(pid) : null;
    if (ageMs === null || ageMs <= CHROME_MAX_AGE_MS) {
      pass(`reachable (${v.Browser || "Chrome"})`);
      await closeBlankTabs();
      return;
    }

    console.log(`  … reachable but ${Math.round(ageMs / 3_600_000)}h old — recycling (same profile/session, fresh process)`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone (e.g. it crashed/quit in the gap between the age check above and
      // here) — nothing to signal; fall through to the reachability poll below, which
      // will find it already unreachable and skip straight to relaunching.
    }
    const freeDeadline = Date.now() + 10_000;
    let stillUp = true;
    while (Date.now() < freeDeadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (!(await cdpReachable())) {
        stillUp = false;
        break;
      }
    }
    if (stillUp) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } else {
    console.log("  … not reachable");
  }

  if (!(await launchChrome())) {
    fail("Chrome did not start in time — open it manually and retry");
  }
}

async function checkInventories() {
  console.log("[doctor] page inventories");
  if (!(await exists(P.searchUrls))) return fail("search_urls.md missing");
  const text = await readFile(P.searchUrls, "utf8");
  const pages = [...text.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1].trim());
  if (!pages.length) return fail("no page-types declared in search_urls.md");
  for (const page of pages) {
    if (await exists(join(ROOT, "page_inventory", `${page}.md`))) pass(`${page} inventory present`);
    else fail(`${page} has no inventory (run /page-analyse)`);
  }
}

async function checkCache() {
  console.log("[doctor] cache");
  try {
    const c = JSON.parse(await readFile(P.cache, "utf8"));
    if (Array.isArray(c.jobs)) pass(`cache.json valid (${c.jobs.length} job(s), last_run=${c.last_run})`);
    else fail("cache.json malformed (no jobs array)");
  } catch {
    fail("cache.json missing/unparseable (run /setup)");
  }
}

async function main() {
  console.log(`[doctor] profile=${resolveProfileName()}`);
  await checkSecrets();
  await checkNotifier();
  await checkGreenhouse();
  await checkProfileFiles();
  await checkCDP();
  await checkInventories();
  await checkCache();
  console.log("");
  if (failed) {
    console.error(`[doctor] ${failed} check(s) failed — not ready to /run.`);
    await notify({
      severity: "blocking",
      title: "Doctor red",
      body: `${failed} check(s) failed`,
    });
    process.exit(1);
  }
  console.log("[doctor] all green — ready to /run.");
  // checkCDP()'s closeBlankTabs() may leave an open CDP/WebSocket handle behind — exit
  // explicitly rather than let the process hang on it (same rationale as extract.js's own
  // "never browser.close(), just process.exit()" note: this attaches to the user's real,
  // persistent Chrome, so we drop the connection without touching the browser itself).
  process.exit(0);
}

main();
