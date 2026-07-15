// scripts/lib/page_actions.js — site-agnostic Playwright page interaction primitives. Takes a
// Playwright Page/Locator and plain option bags — never an inventory cfg object (that's the
// pipeline layer's job to translate into these params).

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PURE — [minMs, maxMs) jitter amount. rand is injectable for deterministic tests.
export function jitterMs(minMs = 2000, maxMs = 5000, rand = Math.random) {
  return minMs + Math.floor(rand() * (maxMs - minMs));
}

export async function jitter(minMs, maxMs) {
  return sleep(jitterMs(minMs, maxMs));
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

// Generalizes extract.js card text(): supports a ":nth(N)" suffix on the selector for pages
// where sibling selectors aren't usable (hashed classes), e.g. "p:nth(1)" → locator("p").nth(1).
// Card fields (title/company/location) are always single-line — takes the first non-empty line
// so that badge text or a11y duplicate spans embedded in the same element don't pollute the value.
export async function safeText(scope, selector, {} = {}) {
  if (!selector) return "";
  const m = selector.match(/:nth\((\d+)\)$/);
  const locator = m
    ? scope.locator(selector.slice(0, -m[0].length)).nth(parseInt(m[1], 10))
    : scope.locator(selector).first();
  const raw = (await locator.innerText().catch(() => "")) ?? "";
  return raw.trim().split("\n").find((l) => l.trim()) ?? "";
}

export async function safeAttr(scope, selector, attr) {
  if (!selector) return null;
  return scope.locator(selector).first().getAttribute(attr).catch(() => null);
}

// Generalizes extract.js's scrollToEnd VERBATIM in behavior: each round — bail on an expired
// budget, bail if endSelector is already present, scroll the container (or the page's own
// scrollingElement) to the bottom, wait, and recount itemSelector; stop once the count has held
// steady for stableRounds consecutive rounds.
export async function scrollUntilStable(
  page,
  { itemSelector, scrollContainer = null, endSelector = null, maxRounds = 40, stableRounds = 3, roundDelayMs = 800, budget = null } = {}
) {
  let stable = 0;
  let lastCount = -1;
  let count = 0;
  for (let i = 0; i < maxRounds; i++) {
    if (budget?.expired()) break;
    if (endSelector && (await page.locator(endSelector).count())) break;
    await page.evaluate((sel) => {
      const el = sel ? document.querySelector(sel) : null;
      (el || document.scrollingElement || document.body).scrollBy(0, 100000);
    }, scrollContainer || null);
    await sleep(roundDelayMs);
    count = await page.locator(itemSelector).count();
    if (count === lastCount) {
      if (++stable >= stableRounds) break; // no growth for stableRounds rounds → done
    } else {
      stable = 0;
      lastCount = count;
    }
  }
  return count;
}
