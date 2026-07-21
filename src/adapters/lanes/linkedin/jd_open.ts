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

    await page.waitFor(inv.selectors.jdRoot, { timeoutMs: waitForTimeoutMs });
    ctx.beat();

    const text = await page.evaluate<string>(buildJdTextScript(inv.selectors.jdRoot), {
      timeoutMs: evaluateTimeoutMs,
    });

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
