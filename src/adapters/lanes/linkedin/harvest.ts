import type { FilterConfig } from '../../../core/filter/config.ts';
import { decide, evaluateCard } from '../../../core/filter/engine.ts';
import type { CardInput } from '../../../core/filter/rules/types.ts';
import { type DroppedRecord, JDSchema } from '../../../core/jd/index.ts';
import type { PageHandle } from '../../../ports/browser.ts';
import type { RunContext } from '../../../ports/context.ts';
import type { Inventory } from './inventory.ts';

/**
 * Batch card harvest + card gate (P4 Task 4, spec §"Card harvest is batch
 * in-page"). harvestCards runs ONE in-page evaluate over the search-results
 * page and maps the raw DOM read into typed cards; gateCards then runs the
 * P2 card-gate rules (title/company only — the rest need structured JD
 * data the card doesn't carry) to split survivors from identity-only
 * drop records.
 */

export interface HarvestedCard extends CardInput {
  url: string;
  id: string;
}

/** Canonical shape, defined in core/jd next to Verdict — re-exported here
 * so existing importers (adapters/lanes/linkedin/index.ts) keep working. */
export type { DroppedRecord };

/** Raw per-card read from the in-page harvest script. Two id sources
 * exist because inventories disagree on where the job id lives:
 * linkedin__jobs-search's cardLink is a real anchor with a /jobs/view/<id>/
 * href; linkedin__jobs-search-results's cardLink duplicates the card
 * selector itself (no href at all) and the id lives in an attribute named
 * by behaviors.jobCardIdAttr (e.g. componentkey) — see cardLinkNote /
 * jobCardIdAttr / jobCardIdAttrPrefix / urlPatternOfJob in that page's
 * inventory JSON. */
interface RawCard {
  title: string;
  company: string;
  location: string;
  href: string;
  idAttr: string | null;
}

const DEFAULT_HARVEST_TIMEOUT_MS = 20_000;
/** Bounded wait for the results list to attach before the in-page read.
 * Matches v0's DEFAULT_CALL_TIMEOUT_MS in scripts/pipeline/extract/cards.js. */
const DEFAULT_READY_TIMEOUT_MS = 30_000;
/** In-page deadline for the hydration pass inside buildHarvestScript's
 * evaluate call (2026-07-25 fix: LinkedIn's results list is virtualized —
 * only ~7 of ~25 cards mount content on load, the rest are empty <li>
 * shells until scrollIntoView()'d into the IntersectionObserver). Kept well
 * under DEFAULT_HARVEST_TIMEOUT_MS (the whole evaluate's own timeout, 15s)
 * so hydration always leaves headroom for the read itself and can never be
 * what times out the call; the pass self-stops at this deadline and reads
 * whatever hydrated so far rather than throwing. */
const HYDRATION_BUDGET_MS = 8_000;
/** Cards scrolled into view per chunk before yielding to the browser —
 * batching (vs. one scrollIntoView + yield per card) keeps the number of
 * yields, and therefore wall-clock cost, low for a ~25-card page. */
const HYDRATION_CHUNK_SIZE = 5;
/** Yield between chunks so the IntersectionObserver actually fires and the
 * framework renders before the next chunk scrolls. */
const HYDRATION_CHUNK_DELAY_MS = 120;
/** In-page budget for the post-hydration settle poll: the hydration scroll
 * pass above only nudges the IntersectionObserver into mounting a card's
 * content, it doesn't guarantee title/company text has actually painted by
 * the time the loop ends — a single unconditional read right after
 * hydration can still race the paint and record an empty title/company,
 * which then fails JDSchema.parse downstream. Same pattern as jd_open.ts's
 * `JD_SETTLE_BUDGET_MS`/`JD_SETTLE_POLL_MS` (settle-and-read instead of a
 * single-shot read), applied to list cards here instead of the JD detail
 * pane there. Self-stopping deadline: never throws on budget exhaustion,
 * just returns whatever settled (possibly still empty). */
const CARD_SETTLE_BUDGET_MS = 8_000;
/** Gap between re-reads during the settle poll — mirrors jd_open.ts's
 * `JD_SETTLE_POLL_MS`. */
const CARD_SETTLE_POLL_MS = 250;
const JOB_ID_RE = /\/jobs\/view\/(\d+)/;
const LINKEDIN_ORIGIN = 'https://www.linkedin.com';

/**
 * Builds the in-page harvest function as a SOURCE STRING (an async IIFE
 * expression) rather than a JS function value — PageHandle.evaluate takes a
 * string so it can be sent to the page over CDP; page.evaluate awaits
 * whatever promise the string's top-level expression resolves to, so an
 * async IIFE needs no call-site change. Pure and unit-testable in isolation
 * via node:vm against a fake `document` (+ `setTimeout`, for the hydration
 * pass's yields).
 *
 * Before the read, a hydration pass scrolls each card into view (in-page,
 * single evaluate — never a per-card Playwright round trip, see the
 * 2026-07-17 stall lesson in harvestCards' doc comment) so LinkedIn's
 * virtualized results list actually mounts every card's content, bounded by
 * HYDRATION_BUDGET_MS so a pathological page can't hang the call.
 *
 * `cardSettleBudgetMs`/`cardSettlePollMs` default to
 * CARD_SETTLE_BUDGET_MS/CARD_SETTLE_POLL_MS and exist as overridable
 * parameters purely so tests can shrink the settle budget instead of
 * genuinely waiting out 8 real seconds (mirrors buildJdSettleScript's
 * `budgetMs`/`pollMs` params in jd_open.ts) — production call sites never
 * pass them.
 */
export function buildHarvestScript(
  inv: Inventory,
  cardSettleBudgetMs: number = CARD_SETTLE_BUDGET_MS,
  cardSettlePollMs: number = CARD_SETTLE_POLL_MS,
): string {
  const sel = inv.selectors;
  const idAttrName = inv.behaviors.jobCardIdAttr ?? null;
  return `(async () => {
  const cardListSel = ${JSON.stringify(sel.cardList)};
  const cardSel = ${JSON.stringify(sel.card)};
  const titleSel = ${JSON.stringify(sel.cardTitle)};
  const companySel = ${JSON.stringify(sel.cardCompany)};
  const locationSel = ${JSON.stringify(sel.cardLocation)};
  const linkSel = ${JSON.stringify(sel.cardLink)};
  const idAttrName = ${JSON.stringify(idAttrName)};
  const hydrationBudgetMs = ${HYDRATION_BUDGET_MS};
  const hydrationChunkSize = ${HYDRATION_CHUNK_SIZE};
  const hydrationChunkDelayMs = ${HYDRATION_CHUNK_DELAY_MS};
  const cardSettleBudgetMs = ${cardSettleBudgetMs};
  const cardSettlePollMs = ${cardSettlePollMs};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (el) => (el && el.textContent ? el.textContent.trim() : '');
  const listEl = document.querySelector(cardListSel);
  const cardEls = listEl ? Array.from(listEl.querySelectorAll(cardSel)) : [];

  // Hydration: LinkedIn's results list is virtualized behind an
  // IntersectionObserver — only the first ~7 of ~25 cards have content
  // mounted on load, the rest are empty <li> shells with no lockup/title/
  // company markup at all. scrollIntoView() on each card nudges the
  // observer to mount it; a bulk scrollTop jump does NOT (per-element
  // intersection, not scroll position — verified live 2026-07-25).
  // Chunked + yielded (await sleep) so the observer/framework get an actual
  // turn between chunks, and deadline-bounded so a pathological page can't
  // hang this evaluate: if the budget runs out we stop hydrating and read
  // whatever is there rather than throwing.
  const hydrationDeadline = Date.now() + hydrationBudgetMs;
  for (let i = 0; i < cardEls.length && Date.now() < hydrationDeadline; i += hydrationChunkSize) {
    const chunk = cardEls.slice(i, i + hydrationChunkSize);
    for (const el of chunk) {
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView();
    }
    await sleep(hydrationChunkDelayMs);
  }

  // Settle poll: the hydration pass above only nudges cards into mounting,
  // it does not guarantee title/company text has actually painted by the
  // time it ends. Re-read only the cards still missing either field, until
  // every card has both non-empty or the budget runs out — self-stopping,
  // so a card that never settles just returns whatever text is present
  // (possibly still empty) rather than hanging this evaluate.
  const needsSettle = (el) =>
    !text(el.querySelector(titleSel)) || !text(el.querySelector(companySel));
  const settleDeadline = Date.now() + cardSettleBudgetMs;
  while (cardEls.some(needsSettle) && Date.now() < settleDeadline) {
    await sleep(cardSettlePollMs);
  }

  return cardEls.map((el) => {
    // cardLink sometimes duplicates the card selector itself (no href on
    // any descendant, e.g. linkedin__jobs-search-results) — querySelector
    // only searches descendants, so check el.matches(linkSel) first and
    // fall back to reading the id off an attribute on the card element.
    const linkEl = el.matches && el.matches(linkSel) ? el : el.querySelector(linkSel);
    return {
      title: text(el.querySelector(titleSel)),
      company: text(el.querySelector(companySel)),
      location: text(el.querySelector(locationSel)),
      href: linkEl ? linkEl.getAttribute('href') || '' : '',
      idAttr: idAttrName ? el.getAttribute(idAttrName) : null,
    };
  });
})()`;
}

/** Strips the inventory-declared id-attribute prefix (e.g.
 * "job-card-component-ref-4021337" → "4021337" for
 * jobCardIdAttrPrefix "job-card-component-ref-") — mirrors v0
 * cards.js:159-160. Returns undefined when there's no attribute value to
 * work with. */
function idFromAttr(
  idAttr: string | null | undefined,
  inv: Inventory,
): string | undefined {
  if (!idAttr) return undefined;
  const prefix = inv.behaviors.jobCardIdAttrPrefix;
  return prefix && idAttr.startsWith(prefix) ? idAttr.slice(prefix.length) : idAttr;
}

/** Builds the job url from behaviors.urlPatternOfJob's "<id>" placeholder
 * (mirrors v0 cards.js's canonicalUrl) — used when the card carries no
 * href at all. Returns undefined when the inventory declares no pattern,
 * since there is then no way to construct a url from an id alone. */
function urlFromPattern(inv: Inventory, id: string): string | undefined {
  const pattern = inv.behaviors.urlPatternOfJob;
  if (!pattern) return undefined;
  return pattern.replace('<id>', id);
}

/**
 * Single batch in-page read of every visible card, mapped to typed
 * HarvestedCards. Never per-card round trips (2026-07-17 stall lesson —
 * see memory). Id resolution: an href carrying a parseable
 * /jobs/view/<id>/ wins when present; otherwise the id comes from the
 * inventory-declared id attribute (behaviors.jobCardIdAttr, prefix
 * stripped per jobCardIdAttrPrefix) — this is how
 * linkedin__jobs-search-results (no href anywhere on the card) still
 * yields an id and a url (built from behaviors.urlPatternOfJob). A card
 * with neither is skipped with a warn — a malformed card must not kill
 * the harvest.
 *
 * `opts.allowEmpty` (default false, page 1's behavior unchanged): when
 * true, a page that yields zero cards — whether because the readiness
 * selector never attached (container missing entirely) or because the
 * in-page read itself came back empty — returns `[]` instead of throwing
 * the emptiness assertions below. This is for tail pages (pageIndex >= 2,
 * set by the caller in lane.ts): end-of-results genuinely looks like an
 * empty page, and that is normal, not a failure — the lane's existing
 * `cards.length === 0` stop branch is what should end pagination, not a
 * SoftError. Genuinely unexpected errors (an `evaluate` crash, a
 * navigation-destroyed context) are not emptiness assertions and still
 * throw regardless of `allowEmpty`.
 */
export async function harvestCards(
  page: PageHandle,
  inv: Inventory,
  ctx: RunContext,
  opts: { timeoutMs?: number; readyTimeoutMs?: number; allowEmpty?: boolean } = {},
): Promise<HarvestedCard[]> {
  const allowEmpty = opts.allowEmpty ?? false;

  // Readiness gate (v0 parity: runAssertions in
  // scripts/pipeline/extract/cards.js). LinkedIn's results page is an SPA —
  // goto() resolves long before the list hydrates, and the in-page script
  // below returns [] for a missing list rather than throwing. Without this
  // wait, a healthy page reads as zero cards, the lane marks the url done,
  // and the whole run reports `passed` having captured nothing (observed on
  // all 21 urls, 2026-07-25). Failing to attach is this url's failure — it
  // throws, so the lane counts it and retries next fire — UNLESS
  // allowEmpty is set, in which case a container that never attached on a
  // tail page just means there's nothing left to paginate, not a failure.
  const readySelector = inv.behaviors.mustExist || inv.selectors.cardList;
  try {
    await page.waitFor(readySelector, {
      timeoutMs: opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    });
  } catch (err) {
    if (allowEmpty) {
      ctx.logger.debug(
        'harvest: readiness selector never attached — treating as end of results (allowEmpty)',
        { page: inv.page, readySelector },
      );
      return [];
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `harvest: results list never attached (selector "${readySelector}"): ${message}`,
    );
  }

  const script = buildHarvestScript(inv);
  const raw = await page.evaluate<RawCard[]>(script, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_HARVEST_TIMEOUT_MS,
  });

  const cards: HarvestedCard[] = [];
  for (const item of raw) {
    const hrefId = item.href ? JOB_ID_RE.exec(item.href)?.[1] : undefined;
    const id = hrefId ?? idFromAttr(item.idAttr, inv);
    if (!id) {
      ctx.logger.warn(
        'harvest: skipping card with no parseable id (href nor id attribute)',
        {
          href: item.href,
          title: item.title,
        },
      );
      continue;
    }
    const url = item.href
      ? new URL(item.href, LINKEDIN_ORIGIN).toString()
      : urlFromPattern(inv, id);
    if (!url) {
      ctx.logger.warn(
        'harvest: skipping card with an id but no url (no href and no urlPatternOfJob behavior)',
        {
          id,
          title: item.title,
        },
      );
      continue;
    }
    cards.push({
      title: item.title,
      company: item.company,
      location: item.location || undefined,
      url,
      id: `li-${id}`,
    });
  }

  // allowEmpty short-circuit: the page attached its container but the
  // in-page read still came back with nothing — on a tail page that's
  // ordinary end-of-results, so return [] quietly instead of running either
  // emptiness assertion below (which exist to catch a broken selector or a
  // logout wall on page 1, where an empty read is NOT expected).
  if (cards.length === 0 && allowEmpty) {
    ctx.logger.debug(
      'harvest: harvested 0 cards — treating as end of results (allowEmpty)',
      {
        page: inv.page,
        readySelector,
      },
    );
    return [];
  }

  // Minimum-cards assertion (v0 parity: `count < min_job_cards` throws).
  // A page that attached its list but produced nothing is a broken selector
  // or a logout wall, not an empty search — loud, so the lane counts the url
  // as failed instead of marking it done with zero captures.
  const minJobCards = Number.parseInt(inv.behaviors.minJobCards ?? '1', 10);
  const min = Number.isNaN(minJobCards) ? 1 : minJobCards;
  if (min > 0 && cards.length < min) {
    throw new Error(
      `harvest: ${cards.length} card(s) on "${inv.page}" is below min ${min} — ` +
        'broken selector or an expired session, not an empty search',
    );
  }
  // min === 0 pages (e.g. linkedin__jobs-search-results, whose inventory
  // declares minJobCards 0) legitimately render empty, so this stays a warn
  // — but it must never be silent, which is how the 2026-07-25 zero-job run
  // went unnoticed.
  if (cards.length === 0) {
    ctx.logger.warn('harvest: harvested 0 cards', {
      page: inv.page,
      readySelector,
    });
  }
  return cards;
}

/**
 * Card-gate: runs the P2 evalCard rules (title, company) against each
 * harvested card. Kept cards pass through unchanged; dropped cards get an
 * identity-only JD (no content/structured yet — the card gate runs before
 * JD open) so the funnel can always answer "why did this disappear?".
 */
export function gateCards(
  cards: HarvestedCard[],
  cfg: FilterConfig,
): { pass: HarvestedCard[]; dropped: DroppedRecord[] } {
  const pass: HarvestedCard[] = [];
  const dropped: DroppedRecord[] = [];
  for (const card of cards) {
    const verdicts = evaluateCard(card, cfg);
    if (decide(verdicts) === 'keep') {
      pass.push(card);
      continue;
    }
    const jd = JDSchema.parse({
      identity: {
        id: card.id,
        lane: 'linkedin',
        url: card.url,
        company: card.company,
        title: card.title,
        scrapedAt: new Date().toISOString(),
      },
    });
    dropped.push({ jd, reasons: verdicts });
  }
  return { pass, dropped };
}
