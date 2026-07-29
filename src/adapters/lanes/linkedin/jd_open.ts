import { SoftError } from '../../../core/errors/index.ts';
import type { PageHandle } from '../../../ports/browser.ts';
import type { RunContext } from '../../../ports/context.ts';
import type { Inventory } from './inventory.ts';

/**
 * Card -> raw JD text (P4 Task 5). Two pageTypes (spec: details-page vs
 * popup): details-page navigates to the card's own url; popup clicks the
 * card in-place on the search-results page. Both converge on the same
 * "wait for jdRoot, read its text" tail. Every underlying PageHandle call
 * is deadline-bound (opts.timeoutMs) — a hang there must not stall the
 * lane; ctx.beat() ticks the watchdog between steps. Any failure (a
 * rejected call or empty extracted text) is recorded as a
 * SoftError('url', ...) against this one card so the lane continues past
 * a single broken JD (spec §7 fail-soft granularity) — no other error
 * type is allowed to escape. Popup pageType clicks the card's title
 * (inv.selectors.cardTitle) to open the JD in-place; details-page
 * navigates straight to the card's own url instead of list-clicking.
 *
 * jdRoot's waitFor is best-effort (v0 parity, scripts/pipeline/extract/jd.js
 * waitSettled's `.catch(() => {})`) — it is a **presence** signal only, kept
 * best-effort so future DOM drift degrades to the anchor fallback below
 * instead of hard failing the card. It is NOT a content-readiness signal:
 * LinkedIn attaches the componentkey-based jdRoot as an EMPTY skeleton at
 * navigation time — right attribute, real layout, no text — and hydrates it
 * seconds later, so `waitFor` resolves on the skeleton long before there is
 * anything to read (2026-07-28). Content readiness is the settle script's
 * job instead: `buildJdSettleScript` polls jdRoot in-page, bounded by
 * `JD_SETTLE_BUDGET_MS`, until it holds trimmed text or the budget expires.
 * The extraction order is therefore settle-read (configured jdRoot
 * selector) first and, if that comes back empty, falls back to scanning the
 * page for the smallest section/div/article/main whose text starts with the
 * inventory's `behaviors.jdAnchorText` (default "About the job") and holds
 * at least `behaviors.jdAnchorMinChars` (default 200) characters (v0's
 * extractJdText). The result reports which path produced the text so the
 * lane can surface "the fallback is carrying this run" — a broken jdRoot
 * selector must create pressure to regenerate the inventory, not stay
 * invisible. Only when both the settle read and the anchor fallback yield
 * nothing does the card fail as before. Evaluate errors that mean "the
 * page/run is gone" (abort, CDP target closed) are rethrown with their real
 * message, never relabeled as empty text.
 *
 * buildJdRootPresenceScript (below) and fire/probe.ts's classifyJdOutcome,
 * which reads it, are deliberately unchanged by this: they now run only
 * after the settle read's 8-second content wait has already failed, so a
 * `shell` verdict finally means "present and still empty after we
 * genuinely waited for hydration" rather than "present and empty the
 * instant we looked".
 */

export interface OpenJdCard {
  id: string;
  url: string;
  title?: string;
}

export interface OpenJdOpts {
  gotoTimeoutMs?: number;
  clickTimeoutMs?: number;
  waitForTimeoutMs?: number;
  evaluateTimeoutMs?: number;
  settleTimeoutMs?: number;
}

const DEFAULT_GOTO_TIMEOUT_MS = 30_000;
const DEFAULT_CLICK_TIMEOUT_MS = 15_000;
/** Shared by both pageTypes: on details-page, goto has already resolved a
 * full page load, so this wait is settle time for the jdRoot's async
 * hydration (observed up to ~15s), not a load signal; on popup, the
 * click-driven pane's jdRoot appearing IS the "JD opened" signal. Either
 * way the wait resolves as soon as the selector matches, so the full cap
 * only costs time on a genuinely broken/drifted page. */
const DEFAULT_WAIT_FOR_TIMEOUT_MS = 15_000;
const DEFAULT_EVALUATE_TIMEOUT_MS = 10_000;
/** In-page budget for the jdRoot settle poll. LinkedIn attaches the
 * `componentkey`-based jdRoot as an EMPTY skeleton at navigation time —
 * correct attribute, real layout box, zero text — and hydrates it seconds
 * later. `waitFor(jdRoot)` is therefore satisfied instantly by the skeleton
 * and proves nothing about content, which is what made a single-shot read
 * race hydration and report "server withheld the JD" for a pane that was
 * merely still loading (2026-07-28). Mirrors harvest.ts's HYDRATION_BUDGET_MS
 * and, like it, stays well under its enclosing evaluate timeout so the poll
 * can never be what times the call out. */
const JD_SETTLE_BUDGET_MS = 8_000;
/** Gap between re-reads. Cheap in-page work, so this is about how fast we
 * notice hydration, not about load. */
const JD_SETTLE_POLL_MS = 250;
/** Evaluate timeout for the settle read specifically — the 8s in-page budget
 * needs headroom above it, exactly as harvest's 8s budget sits under its 15s
 * evaluate. The other scripts in this file keep DEFAULT_EVALUATE_TIMEOUT_MS. */
const DEFAULT_SETTLE_TIMEOUT_MS = 15_000;

/** Anchor-text fallback DEFAULTS (v0 scripts/pipeline/extract/jd.js
 * extractJdText) — used only when the inventory carries no
 * `behaviors.jdAnchorText`/`jdAnchorMinChars`; both committed inventories
 * already set the anchor text, and inventory-first is the rule (CLAUDE.md:
 * DOM/copy drift is fixed by regenerating the inventory, not lane code).
 * The anchor phrase is the heading every LinkedIn JD pane starts with; the
 * minimum length filters out the bare heading itself and picks real JD
 * content. */
const JD_ANCHOR_TEXT = 'About the job';
const JD_ANCHOR_MIN_CHARS = 200;

/** True for errors that mean the run/page is gone (an AbortSignal firing,
 * CDP target/session death) rather than "this script found nothing" —
 * these must propagate with their real message so the lane's failure
 * evidence blames the actual cause, not the jdRoot selector. */
function isPageGoneError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  return /abort|target closed|session closed|disconnect|browser has been closed/i.test(
    err.message,
  );
}

/** In-page SETTLE-AND-READ of jdRoot: poll until the element holds trimmed
 * text or the budget expires, then return what it found (`''` if nothing).
 *
 * This replaces a single-shot `querySelector().innerText` read. That read
 * ran the instant `waitFor(jdRoot)` resolved, and `waitFor` resolves on the
 * skeleton — so a perfectly healthy JD that hydrated 3 seconds later was
 * recorded as empty, failed as a SoftError, and classified as the
 * server-withheld shell signature. Three of those in a fire opened a 4-hour
 * breaker for a page that had loaded fine (2026-07-28).
 *
 * Written as an async IIFE SOURCE STRING, not a function value, because
 * PageHandle.evaluate takes a string to send over CDP; page.evaluate awaits
 * whatever promise the top-level expression resolves to, so an async IIFE
 * needs no call-site change (same as harvest.ts's buildHarvestScript).
 *
 * The `jd-settle` comment token is load-bearing: lane.test.ts's single fake
 * `evaluate` routes scripts by inspecting their source, exactly as
 * `jd-root-presence` below and `cardListSel` in the harvest script do.
 * Exported for direct vm-based testing. */
export function buildJdSettleScript(
  jdRootSelector: string,
  budgetMs: number = JD_SETTLE_BUDGET_MS,
  pollMs: number = JD_SETTLE_POLL_MS,
): string {
  return `(async () => {
  // jd-settle
  const sel = ${JSON.stringify(jdRootSelector)};
  const budgetMs = ${budgetMs};
  const pollMs = ${pollMs};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const read = () => {
    const el = document.querySelector(sel);
    if (!el) return '';
    const text = el.innerText || el.textContent || '';
    return text.trim();
  };
  const deadline = Date.now() + budgetMs;
  let text = read();
  while (!text && Date.now() < deadline) {
    await sleep(pollMs);
    text = read();
  }
  return text;
})()`;
}

/** In-page scan for the smallest section/div/article/main whose text
 * starts with the anchor phrase and clears the minimum length — mirrors
 * v0's extractJdText fallback exactly (tightest container that starts
 * with the anchor AND holds real content, sorted ascending by length).
 * Exported for direct vm-based testing (see jd_open.test.ts), same
 * pattern as harvest.ts's buildHarvestScript. */
export function buildJdAnchorScript(
  anchorText: string = JD_ANCHOR_TEXT,
  minChars: number = JD_ANCHOR_MIN_CHARS,
): string {
  return `(() => {
  const anchor = ${JSON.stringify(anchorText)};
  const minChars = ${minChars};
  const els = [...document.querySelectorAll('section, div, article, main')];
  const matches = els
    .map((e) => (e.innerText || e.textContent || '').trim())
    .filter((t) => t.startsWith(anchor) && t.length >= minChars)
    .sort((a, b) => a.length - b.length);
  return matches[0] || '';
})()`;
}

/** In-page TRI-STATE read of jdRoot for the throttle guard (spec D4):
 * `'empty'` when the selector matches an element whose trimmed text is
 * empty, `'text'` when it matches an element that still holds text, and
 * `''` when it matches nothing at all.
 *
 * This exists because `buildJdSettleScript` above cannot answer the question
 * the throttle guard needs: a settle-and-read returns `''` both for "jdRoot
 * matched nothing" (selector drift) and for "jdRoot matched but stayed
 * empty for the whole settle budget" (the server-withheld skeleton shell
 * LinkedIn serves to a soft-blocked session — spec §1/§4.3). Those two are
 * different failures with opposite fixes (regenerate the inventory vs. back
 * off), so the lane runs this script after a failed JD open to tell them
 * apart.
 *
 * The third state is what keeps the guard honest, and is why presence
 * alone is not enough: a failed JD open can leave a POPULATED pane in the
 * DOM (a goto timeout that never navigated away from the previous card's
 * JD is the common one). Read as mere presence that is the shell
 * signature, and three such failures would open a 4-hour breaker for
 * something that is not a throttle at all. So `'shell'` requires
 * matched-AND-empty — exactly what D4 specifies — and a matched pane with
 * text reads as neutral.
 *
 * The `jd-root-presence` comment token is load-bearing: lane.test.ts's
 * single fake `evaluate` routes scripts by inspecting their source (the
 * same trick that routes the harvest script by its `cardListSel`
 * declaration), so this script must stay identifiable. Exported for direct
 * vm-based testing, same pattern as buildJdAnchorScript. */
export function buildJdRootPresenceScript(jdRootSelector: string): string {
  return `(() => {
  // jd-root-presence
  const el = document.querySelector(${JSON.stringify(jdRootSelector)});
  if (!el) return '';
  const text = el.innerText || el.textContent || '';
  return text.trim() ? 'text' : 'empty';
})()`;
}

export interface JdOpenResult {
  text: string;
  /** Which extraction path produced the text — the configured jdRoot
   * selector or the anchor-text fallback. */
  source: 'jdRoot' | 'anchor';
}

export async function openJd(
  page: PageHandle,
  card: OpenJdCard,
  inv: Inventory,
  ctx: RunContext,
  opts: OpenJdOpts = {},
): Promise<JdOpenResult> {
  const gotoTimeoutMs = opts.gotoTimeoutMs ?? DEFAULT_GOTO_TIMEOUT_MS;
  const clickTimeoutMs = opts.clickTimeoutMs ?? DEFAULT_CLICK_TIMEOUT_MS;
  const waitForTimeoutMs = opts.waitForTimeoutMs ?? DEFAULT_WAIT_FOR_TIMEOUT_MS;
  const evaluateTimeoutMs = opts.evaluateTimeoutMs ?? DEFAULT_EVALUATE_TIMEOUT_MS;
  const settleTimeoutMs = opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const anchorText = inv.behaviors.jdAnchorText ?? JD_ANCHOR_TEXT;
  const anchorMinCharsRaw = Number(inv.behaviors.jdAnchorMinChars);
  const anchorMinChars =
    Number.isFinite(anchorMinCharsRaw) && anchorMinCharsRaw > 0
      ? anchorMinCharsRaw
      : JD_ANCHOR_MIN_CHARS;

  // A script error means "this extraction found nothing" and yields '' so
  // the next path can try — but a gone page/run rethrows (see
  // isPageGoneError): relabeling an abort as "empty text" sends the
  // operator chasing the jdRoot selector for what was a dead browser.
  const evalText = async (
    script: string,
    timeoutMs: number = evaluateTimeoutMs,
  ): Promise<string> => {
    try {
      const out = await page.evaluate<string>(script, { timeoutMs });
      return (out ?? '').trim();
    } catch (err) {
      if (isPageGoneError(err)) throw err;
      ctx.logger.debug('jd open: evaluate failed, treating as empty', {
        url: card.url,
        message: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
  };

  try {
    if (inv.pageType === 'details-page') {
      await page.goto(card.url, { timeoutMs: gotoTimeoutMs });
    } else {
      await page.click(inv.selectors.cardTitle, { timeoutMs: clickTimeoutMs });
    }
    ctx.beat();

    // Best-effort (v0 parity): a timeout here does not fail the card. This
    // is a PRESENCE signal only — it resolves as soon as jdRoot attaches,
    // which LinkedIn does as an empty skeleton, so it proves nothing about
    // content (that is the settle script's job, below). It stays
    // best-effort/fail-soft so any future DOM drift that breaks the
    // selector degrades to the anchor-text fallback, not a hard failure.
    await page
      .waitFor(inv.selectors.jdRoot, { timeoutMs: waitForTimeoutMs })
      .catch((err) => {
        ctx.logger.debug('jd open: waitFor(jdRoot) timed out, continuing best-effort', {
          url: card.url,
          jdRoot: inv.selectors.jdRoot,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    ctx.beat();

    let source: JdOpenResult['source'] = 'jdRoot';
    let text = await evalText(buildJdSettleScript(inv.selectors.jdRoot), settleTimeoutMs);

    if (!text) {
      source = 'anchor';
      text = await evalText(buildJdAnchorScript(anchorText, anchorMinChars));
    }

    if (!text) {
      throw new Error(
        `extracted JD text was empty (jdRoot ${inv.selectors.jdRoot}, anchor "${anchorText}")`,
      );
    }

    return { text, source };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SoftError('url', `JD open failed for ${card.url}: ${message}`, {
      cause: err,
    });
  }
}
