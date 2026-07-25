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
 * matches, so a timeout there must not by itself fail the card. Text
 * extraction then tries the configured jdRoot selector first and, if that
 * comes back empty, falls back to scanning the page for the smallest
 * section/div/article/main whose text starts with JD_ANCHOR_TEXT and holds
 * at least JD_ANCHOR_MIN_CHARS characters (v0's extractJdText). Only when
 * both the selector and the anchor fallback yield nothing does the card
 * fail as before.
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
const DEFAULT_EVALUATE_TIMEOUT_MS = 10_000;

/** Anchor-text fallback (v0 scripts/pipeline/extract/jd.js extractJdText):
 * heading text every LinkedIn JD pane starts with, stable across the
 * hashed-class-name churn that breaks the configured jdRoot selector on
 * the direct-nav job page. */
const JD_ANCHOR_TEXT = 'About the job';
/** Minimum length (chars) for a fallback match — filters out the bare
 * "About the job" heading itself and picks real JD content, not just any
 * element that happens to start with the anchor phrase. */
const JD_ANCHOR_MIN_CHARS = 200;

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
export function buildJdAnchorScript(): string {
  return `(() => {
  const anchor = ${JSON.stringify(JD_ANCHOR_TEXT)};
  const minChars = ${JD_ANCHOR_MIN_CHARS};
  const els = [...document.querySelectorAll('section, div, article, main')];
  const matches = els
    .map((e) => (e.innerText || e.textContent || '').trim())
    .filter((t) => t.startsWith(anchor) && t.length >= minChars)
    .sort((a, b) => a.length - b.length);
  return matches[0] || '';
})()`;
}

export async function openJd(
  page: PageHandle,
  card: OpenJdCard,
  inv: Inventory,
  ctx: RunContext,
  opts: OpenJdOpts = {},
): Promise<string> {
  const gotoTimeoutMs = opts.gotoTimeoutMs ?? DEFAULT_GOTO_TIMEOUT_MS;
  const clickTimeoutMs = opts.clickTimeoutMs ?? DEFAULT_CLICK_TIMEOUT_MS;
  const waitForTimeoutMs = opts.waitForTimeoutMs ?? DEFAULT_WAIT_FOR_TIMEOUT_MS;
  const evaluateTimeoutMs = opts.evaluateTimeoutMs ?? DEFAULT_EVALUATE_TIMEOUT_MS;

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

    let text = (
      await page
        .evaluate<string>(buildJdTextScript(inv.selectors.jdRoot), {
          timeoutMs: evaluateTimeoutMs,
        })
        .catch(() => '')
    ).trim();

    if (!text) {
      text = (
        await page
          .evaluate<string>(buildJdAnchorScript(), { timeoutMs: evaluateTimeoutMs })
          .catch(() => '')
      ).trim();
    }

    if (!text) {
      throw new Error(`extracted JD text was empty (jdRoot ${inv.selectors.jdRoot})`);
    }

    return text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SoftError('url', `JD open failed for ${card.url}: ${message}`, {
      cause: err,
    });
  }
}
