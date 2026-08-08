import type { Inventory } from '../inventory.ts';

/** Raw per-card read from the in-page harvest script. Two id sources
 * exist because inventories disagree on where the job id lives:
 * linkedin__jobs-search's cardLink is a real anchor with a /jobs/view/<id>/
 * href; linkedin__jobs-search-results's cardLink duplicates the card
 * selector itself (no href at all) and the id lives in an attribute named
 * by behaviors.jobCardIdAttr (e.g. componentkey) — see cardLinkNote /
 * jobCardIdAttr / jobCardIdAttrPrefix / urlPatternOfJob in that page's
 * inventory JSON. */
export interface RawCard {
  title: string;
  company: string;
  location: string;
  href: string;
  idAttr: string | null;
}

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
