// scripts/lib/page_actions.js — site-agnostic Playwright page interaction primitives. Takes a
// Playwright Page/Locator and plain option bags — never an inventory cfg object (that's the
// pipeline layer's job to translate into these params).

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared default deadline for a single CDP round-trip (withTimeout below, and every caller's
// per-call bound) — one place to bump instead of several drifting copies.
export const DEFAULT_CALL_TIMEOUT_MS = 10_000;

// PURE — [minMs, maxMs) jitter amount. rand is injectable for deterministic tests.
export function jitterMs(minMs = 2000, maxMs = 5000, rand = Math.random) {
  return minMs + Math.floor(rand() * (maxMs - minMs));
}

export async function jitter(minMs, maxMs) {
  return sleep(jitterMs(minMs, maxMs));
}

// Hard wall-clock bound on any CDP-backed promise. Playwright bounds *locator actions* with its
// default 30s action timeout, but page.evaluate()/locator.count() have NO deadline at all — on a
// wedged tab/renderer they hang forever (observed: a scheduled run frozen >30min at load-url).
// The underlying call isn't cancelled (CDP can't), but the caller gets control back and can
// recycle the tab. The timer is cleared on settle so it never holds the event loop open.
export function withTimeout(promise, ms = DEFAULT_CALL_TIMEOUT_MS, label = "call") {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} exceeded ${ms}ms deadline`);
      err.name = "DeadlineError"; // stable marker for callers (message wording is free to change)
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Generalizes extract.js's COLLECT_CARDS_MAX_MS wall-clock cap pattern into a reusable budget.
export function createBudget(maxMs, { now = Date.now } = {}) {
  const start = now();
  const elapsed = () => now() - start;
  const remaining = () => Math.max(0, maxMs - elapsed());
  const expired = () => elapsed() >= maxMs;
  return { elapsed, remaining, expired };
}

export async function gotoWithRetry(
  page,
  url,
  { retries = 2, waitUntil = "domcontentloaded", timeoutMs = 30_000, backoffMs = (attempt) => 3000 * attempt, log = console } = {}
) {
  const totalAttempts = 1 + retries;
  let lastErr;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return await page.goto(url, { waitUntil, timeout: timeoutMs });
    } catch (err) {
      lastErr = err;
      if (attempt < totalAttempts) {
        log.warn?.(`[page_actions] goto ${url} failed (attempt ${attempt}/${totalAttempts}) — ${err.message}`);
        await sleep(backoffMs(attempt));
      }
    }
  }
  throw lastErr;
}
