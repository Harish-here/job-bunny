// scripts/lib/browser.js — Chrome-over-CDP lifecycle utilities shared by doctor.js and
// extract.js. Site-agnostic: no inventory/profile knowledge here, just the Chrome process and
// the CDP attach itself.

import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { chromium } from "playwright";
import { ROOT, CHROME_BIN } from "./config.js";

export const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:9222";
export const CDP_PORT = (() => { try { return new URL(CDP_URL).port || "9222"; } catch { return "9222"; } })();
export const CHROME_DATA_DIR = join(ROOT, ".chrome-debug");

// The debug Chrome instance is never restarted on its own — CDP-reachable used to be the
// only thing checkCDP verified. Left alone across days it just accumulates tabs/memory (found
// via a live incident: 3-day uptime, 80% swap used, 56 Chrome processes on an 8GB machine).
// Recycling past this age keeps the same on-disk profile/LinkedIn session intact — only the
// process restarts, never the user-data-dir — while capping how long any one instance lives.
export const CHROME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function cdpReachable({ url = CDP_URL, timeoutMs = 2000 } = {}) {
  try {
    const res = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function getChromePid() {
  try {
    const out = execFileSync("lsof", ["-ti", `:${CDP_PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim();
    const pid = out.split("\n")[0];
    return pid ? Number(pid) : null;
  } catch {
    return null;
  }
}

// ps `etime` format: [[DD-]HH:]MM:SS
export function parseEtimeToMs(etime) {
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

export function getProcessAgeMs(pid) {
  try {
    const etime = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return parseEtimeToMs(etime);
  } catch {
    return null;
  }
}

// PURE — decides what ensureChrome should do next given the current reachability/age.
export function decideChromeAction({ reachable, ageMs, maxAgeMs = CHROME_MAX_AGE_MS }) {
  if (!reachable) return "launch";
  if (ageMs != null && ageMs > maxAgeMs) return "recycle";
  return "reuse";
}

// A reused Chrome process (the normal, CDP-reachable-and-fresh path) may still be carrying tabs
// left open by a run that never tore down cleanly — a watchdog SIGKILL after its grace period,
// or a silent OS-sleep process-tree kill (both already documented above and in run_scheduled.sh).
// createSession()'s tab registry is scoped to one process, so a prior run's leftover tabs are
// invisible to the next run's session and would otherwise just accumulate forever. Closed over
// the same CDP attach path extract.js uses, following its documented rule: never browser.close()
// here — this attaches to the user's real, persistent Chrome, and closing the Browser object over
// CDP would take the whole process down with it. Closing every tab (not just blank/new-tab ones)
// is safe — the persistent LinkedIn login lives in the .chrome-debug/ user-data-dir's
// cookies/local-storage, not in any open tab.
export async function closeExistingTabs({ url = CDP_URL } = {}) {
  try {
    const browser = await chromium.connectOverCDP(url, { noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) return;
    await Promise.all(context.pages().map((page) => page.close().catch(() => {})));
  } catch {
    // best-effort cleanup only — never fail the caller over it
  }
}

export async function ensureChrome({ recycleIfOld = true, launchTimeoutMs = 10_000, log = console } = {}) {
  const v = await cdpReachable();
  const pid = v ? getChromePid() : null;
  const ageMs = pid !== null ? getProcessAgeMs(pid) : null;
  const action = decideChromeAction({ reachable: !!v, ageMs });

  if (action === "reuse") {
    await closeExistingTabs();
    return { launched: false, recycled: false, version: v };
  }

  let recycled = false;
  if (action === "recycle") {
    if (!recycleIfOld) {
      return { launched: false, recycled: false, version: v };
    }
    log.log?.(
      `  … reachable but ${Math.round((ageMs ?? 0) / 3_600_000)}h old — recycling (same profile/session, fresh process)`
    );
    // killChrome polls the port listener (getChromePid), not CDP HTTP reachability — that's the
    // correct "port is free to relaunch" signal here, not "CDP stopped responding".
    await killChrome({ graceMs: 10_000, log });
    recycled = true;
  }

  // launch (either action === "launch", or we fell through from a recycle above)
  log.log?.("  … launching Chrome with debug profile");
  const child = spawn(CHROME_BIN, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CHROME_DATA_DIR}`,
  ], { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + launchTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const nv = await cdpReachable();
    if (nv) {
      await closeExistingTabs();
      return { launched: true, recycled, version: nv };
    }
  }
  throw new Error("Chrome did not start in time");
}

export async function killChrome({ graceMs = 5000, log = console } = {}) {
  try {
    const pid = getChromePid();
    if (!pid) return false;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return false; // already gone
    }
    const deadline = Date.now() + graceMs;
    let stillUp = true;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      if (!getChromePid()) {
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
      await new Promise((r) => setTimeout(r, 500));
    }
    return true;
  } catch (err) {
    log.warn?.(`[browser] killChrome: ${err.message}`);
    return false;
  }
}

// noDefaults: this is a real, user-owned Chrome (the persistent .chrome-debug/ LinkedIn
// session), not a browser Playwright launched itself. Without it, connectOverCDP's default
// Browser.setDownloadBehavior override throws "Browser context management is not supported"
// on Chrome builds that don't expose multi-context download/focus/media management to CDP.
export async function connectCDP({ url = CDP_URL } = {}) {
  const browser = await chromium.connectOverCDP(url, { noDefaults: true });
  const context = browser.contexts()[0] || (await browser.newContext());
  return { browser, context };
}

// Tab registry + transparent reconnect. When LinkedIn closes our tab the whole CDP context
// can die — openTab() reconnects once and retries rather than propagating the error.
export function createSession({ url = CDP_URL, log = console } = {}) {
  let browser = null;
  let context = null;
  const registered = new Set();

  async function ensureConnected() {
    if (!context) {
      ({ browser, context } = await connectCDP({ url }));
    }
    return context;
  }

  async function openTab() {
    const ctx = await ensureConnected();
    try {
      const page = await ctx.newPage();
      registered.add(page);
      return page;
    } catch (e) {
      if (!/closed/i.test(e.message)) throw e;
      log.warn?.("[browser]   context lost — reconnecting to CDP...");
      ({ browser, context } = await connectCDP({ url }));
      const page = await context.newPage();
      registered.add(page);
      return page;
    }
  }

  async function closeTab(page) {
    await page.close().catch(() => {});
    registered.delete(page);
  }

  async function closeAllTabs() {
    for (const page of [...registered]) {
      await closeTab(page).catch(() => {});
    }
  }

  function disconnect() {
    // NEVER browser.close() on a CDP attach — this is the user's real, persistent Chrome;
    // closing the Browser object over CDP would take the whole process down with it. The
    // process exit / killChrome() handles the rest.
    browser = null;
    context = null;
    registered.clear();
  }

  return { openTab, closeTab, closeAllTabs, disconnect };
}
