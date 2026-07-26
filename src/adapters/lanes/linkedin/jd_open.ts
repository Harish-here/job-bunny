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
 * waitSettled's `.catch(() => {})`) — a direct-nav job page can render its
 * content under hashed class names the inventory's jdRoot selector never
 * matches, so a timeout there must not by itself fail the card; on
 * details-page (where that mismatch is the committed inventories' live
 * reality) the wait is capped short so 40 cards don't burn 15s each on a
 * selector known not to match. Text extraction then tries the configured
 * jdRoot selector first and, if that comes back empty, falls back to
 * scanning the page for the smallest section/div/article/main whose text
 * starts with the inventory's `behaviors.jdAnchorText` (default "About the
 * job") and holds at least `behaviors.jdAnchorMinChars` (default 200)
 * characters (v0's extractJdText). The result reports which path produced
 * the text so the lane can surface "the fallback is carrying this run" —
 * a broken jdRoot selector must create pressure to regenerate the
 * inventory, not stay invisible. Only when both the selector and the
 * anchor fallback yield nothing does the card fail as before. Evaluate
 * errors that mean "the page/run is gone" (abort, CDP target closed) are
 * rethrown with their real message, never relabeled as empty text.
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
}

const DEFAULT_GOTO_TIMEOUT_MS = 30_000;
const DEFAULT_CLICK_TIMEOUT_MS = 15_000;
const DEFAULT_WAIT_FOR_TIMEOUT_MS = 15_000;
/** details-page only: goto has already resolved a full page load, so this
 * wait is settle time for async hydration, not a load signal — and the
 * committed inventories' jdRoot (#job-details) never matches direct-nav
 * pages at all, making the full 15s a guaranteed per-card dead wait
 * (~10 min per url at the 40-card cap). Popup keeps the long wait: there
 * the click-driven pane's jdRoot appearing IS the "JD opened" signal. */
const DEFAULT_DETAILS_WAIT_FOR_TIMEOUT_MS = 5_000;
const DEFAULT_EVALUATE_TIMEOUT_MS = 10_000;

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

/** In-page read of jdRoot's text, trimmed. innerText falls back to
 * textContent for environments (fakes/older DOMs) that lack it. */
function buildJdTextScript(jdRootSelector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(jdRootSelector)});
  if (!el) return '';
  const text = el.innerText || el.textContent || '';
  return text.trim();
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
  const waitForTimeoutMs =
    opts.waitForTimeoutMs ??
    (inv.pageType === 'details-page'
      ? DEFAULT_DETAILS_WAIT_FOR_TIMEOUT_MS
      : DEFAULT_WAIT_FOR_TIMEOUT_MS);
  const evaluateTimeoutMs = opts.evaluateTimeoutMs ?? DEFAULT_EVALUATE_TIMEOUT_MS;
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
  const evalText = async (script: string): Promise<string> => {
    try {
      const out = await page.evaluate<string>(script, { timeoutMs: evaluateTimeoutMs });
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

    // Best-effort (v0 parity): a timeout here does not fail the card —
    // the direct-nav job page's jdRoot can be hidden behind hashed class
    // names that never satisfy this selector even though the JD content
    // is present and readable via the anchor-text fallback below.
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
    let text = await evalText(buildJdTextScript(inv.selectors.jdRoot));

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
