import type { Inventory } from '../inventory.ts';

/** Raw per-card read from the in-page harvest script. Two id sources
 * exist because inventories disagree on where the job id lives:
 * linkedin__jobs-search's cardLink is a real anchor with a /jobs/view/<id>/
 * href; linkedin__jobs-search-results's cardLink duplicates the card
 * selector itself (no href at all) and the id lives in an attribute named
 * by behaviors.jobCardIdAttr (e.g. componentkey) — see cardLinkNote /
 * jobCardIdAttrPrefix / urlPatternOfJob in that page's inventory JSON. */
export interface RawCard {
  title: string;
  company: string;
  location: string;
  href: string;
  idAttr: string | null;
}

/** Optional overrides for buildHarvestScript's in-page budgets — exist so
 * tests can shrink them instead of genuinely waiting; production call sites
 * pass nothing and get the module constants below. */
export interface HarvestScriptOpts {
  chunkSettleBudgetMs?: number;
  chunkSettlePollMs?: number;
  repairPerCardBudgetMs?: number;
  repairPageBudgetMs?: number;
  totalBudgetMs?: number;
}

/** Per-page diagnostics emitted alongside the cards, logged by harvestCards
 * at debug level — this is how the residual "why did a page fail to mount
 * at all?" question gets answered from production data instead of another
 * live probe. */
export interface HarvestDiag {
  cardCount: number;
  chunks: number;
  emptyAfterRead: number;
  repairAttempted: number;
  repairRecovered: number;
  emptyAfterRepair: number;
  elapsedMs: number;
}

/** Cards scrolled into view — and then read — per batch. One in-page
 * evaluate covers the whole page; never a per-card Playwright round trip
 * (2026-07-17 stall lesson). */
const CHUNK_SIZE = 5;
/** How long one chunk may take to mount before we read it anyway. Short
 * because a chunk that is genuinely in the viewport mounts in well under a
 * second; the repair pass, not this budget, is what handles a straggler. */
const CHUNK_SETTLE_BUDGET_MS = 1_500;
/** Gap between re-reads while waiting for a chunk to mount. */
const CHUNK_SETTLE_POLL_MS = 100;
/** Per-card ceiling in the repair pass. */
const REPAIR_PER_CARD_BUDGET_MS = 1_500;
/** Whole-page ceiling for the repair pass. Deliberately too small to
 * rescue a wholly-unmounted page: that is a systemic failure to report,
 * not one to grind through. */
const REPAIR_PAGE_BUDGET_MS = 10_000;
/** Hard ceiling for the entire in-page evaluate, binding over both budgets
 * above, and kept under `DEFAULT_HARVEST_TIMEOUT_MS` (20 s in harvest.ts)
 * so this script can never be what times the call out. */
const SCRIPT_TOTAL_BUDGET_MS = 15_000;

/**
 * Builds the in-page harvest function as a SOURCE STRING (an async IIFE
 * expression) rather than a JS function value — PageHandle.evaluate takes a
 * string so it can be sent to the page over CDP; page.evaluate awaits
 * whatever promise the string's top-level expression resolves to, so an
 * async IIFE needs no call-site change. Pure and unit-testable in isolation
 * via node:vm against a fake `document` (+ `setTimeout`, for the read/repair
 * loops' yields).
 *
 * Read-as-you-go: LinkedIn's results list is virtualized — a card mounts
 * when it INTERSECTS the viewport, not when time passes. So this scrolls
 * one chunk of cards into view, waits (briefly) for that chunk to mount,
 * reads exactly that chunk, and moves on — never scrolling the whole list
 * first and reading afterwards, which leaves every card past the initial
 * chunk unreadable no matter how long a subsequent wait runs (diagnosis
 * 2026-08-09: 740 of 1625 cards lost in one run, always a contiguous
 * suffix from position 7). A bounded repair pass then gives any still-empty
 * card another scroll — re-entering the viewport is the actual mount
 * trigger — rather than another second of waiting.
 *
 * The five `opts` fields exist so tests can shrink budgets instead of
 * genuinely waiting; production call sites pass nothing.
 */
export function buildHarvestScript(inv: Inventory, opts: HarvestScriptOpts = {}): string {
  const sel = inv.selectors;
  const idAttrName = inv.behaviors.jobCardIdAttr ?? null;
  const chunkSettleBudgetMs = opts.chunkSettleBudgetMs ?? CHUNK_SETTLE_BUDGET_MS;
  const chunkSettlePollMs = opts.chunkSettlePollMs ?? CHUNK_SETTLE_POLL_MS;
  const repairPerCardBudgetMs = opts.repairPerCardBudgetMs ?? REPAIR_PER_CARD_BUDGET_MS;
  const repairPageBudgetMs = opts.repairPageBudgetMs ?? REPAIR_PAGE_BUDGET_MS;
  const totalBudgetMs = opts.totalBudgetMs ?? SCRIPT_TOTAL_BUDGET_MS;
  return `(async () => {
  const cardListSel = ${JSON.stringify(sel.cardList)};
  const cardSel = ${JSON.stringify(sel.card)};
  const titleSel = ${JSON.stringify(sel.cardTitle)};
  const companySel = ${JSON.stringify(sel.cardCompany)};
  const locationSel = ${JSON.stringify(sel.cardLocation)};
  const linkSel = ${JSON.stringify(sel.cardLink)};
  const idAttrName = ${JSON.stringify(idAttrName)};
  const chunkSize = ${CHUNK_SIZE};
  const chunkSettleBudgetMs = ${chunkSettleBudgetMs};
  const chunkSettlePollMs = ${chunkSettlePollMs};
  const repairPerCardBudgetMs = ${repairPerCardBudgetMs};
  const repairPageBudgetMs = ${repairPageBudgetMs};
  const totalBudgetMs = ${totalBudgetMs};
  const startedAt = Date.now();
  const totalDeadline = startedAt + totalBudgetMs;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (el) => (el && el.textContent ? el.textContent.trim() : '');
  const listEl = document.querySelector(cardListSel);
  const cardEls = listEl ? Array.from(listEl.querySelectorAll(cardSel)) : [];

  // cardLink sometimes duplicates the card selector itself (no href on any
  // descendant, e.g. linkedin__jobs-search-results) — querySelector only
  // searches descendants, so check el.matches(linkSel) first and fall back
  // to reading the id off an attribute on the card element.
  const readCard = (el) => {
    const linkEl = el.matches && el.matches(linkSel) ? el : el.querySelector(linkSel);
    return {
      title: text(el.querySelector(titleSel)),
      company: text(el.querySelector(companySel)),
      location: text(el.querySelector(locationSel)),
      href: linkEl ? linkEl.getAttribute('href') || '' : '',
      idAttr: idAttrName ? el.getAttribute(idAttrName) : null,
    };
  };
  // "Mounted" is the ONLY readable-card test in this script: both identity
  // fields non-empty. A card missing either is rejected by gateCards
  // downstream, so there is nothing else worth waiting for.
  const mounted = (c) => Boolean(c.title) && Boolean(c.company);
  const bring = (el) => {
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView();
  };

  // Read-as-you-go. The list is virtualized: a card mounts when it
  // INTERSECTS the viewport, not when time passes, and it is only reliably
  // readable while it is still there. So scroll a chunk in, wait for that
  // chunk to mount, read exactly that chunk, and never look at it again —
  // the mounted window and the window being read are the same window by
  // construction. The old script scrolled the whole list first and read
  // afterwards, by which point every card past the initial ~7 had been
  // scrolled away from and no amount of waiting could mount it (diagnosis
  // 2026-08-09: 740 of 1625 cards lost in one run, always a contiguous
  // suffix from position 7).
  const out = new Array(cardEls.length);
  let chunks = 0;
  for (let i = 0; i < cardEls.length; i += chunkSize) {
    const chunk = cardEls.slice(i, i + chunkSize);
    chunks += 1;
    for (const el of chunk) bring(el);
    const chunkDeadline = Math.min(Date.now() + chunkSettleBudgetMs, totalDeadline);
    while (chunk.some((el) => !mounted(readCard(el))) && Date.now() < chunkDeadline) {
      await sleep(chunkSettlePollMs);
    }
    for (let j = 0; j < chunk.length; j += 1) out[i + j] = readCard(chunk[j]);
    if (Date.now() >= totalDeadline) {
      // Total budget spent mid-sweep: read whatever the remaining cards
      // hold right now rather than returning holes. Self-stopping — a
      // short read is a recorded casualty, a hung evaluate is a failed url.
      for (let k = i + chunk.length; k < cardEls.length; k += 1) {
        out[k] = readCard(cardEls[k]);
      }
      break;
    }
  }

  let emptyAfterRead = 0;
  for (const c of out) if (!mounted(c)) emptyAfterRead += 1;

  // Bounded repair pass. Re-entering the viewport is the actual mount
  // trigger, so a straggler gets another scroll rather than another
  // second — precisely what the deleted whole-list settle loop could not
  // do, because it only ever waited while every straggler sat off-screen.
  let repairAttempted = 0;
  let repairRecovered = 0;
  const repairDeadline = Math.min(Date.now() + repairPageBudgetMs, totalDeadline);
  for (let i = 0; i < out.length && Date.now() < repairDeadline; i += 1) {
    if (mounted(out[i])) continue;
    repairAttempted += 1;
    bring(cardEls[i]);
    const cardDeadline = Math.min(Date.now() + repairPerCardBudgetMs, repairDeadline);
    let next = readCard(cardEls[i]);
    while (!mounted(next) && Date.now() < cardDeadline) {
      await sleep(chunkSettlePollMs);
      next = readCard(cardEls[i]);
    }
    // Only a fully-mounted re-read replaces the stored record: never trade
    // a partial read for a worse one.
    if (mounted(next)) {
      out[i] = next;
      repairRecovered += 1;
    }
  }

  let emptyAfterRepair = 0;
  for (const c of out) if (!mounted(c)) emptyAfterRepair += 1;

  return {
    cards: out,
    diag: {
      cardCount: cardEls.length,
      chunks: chunks,
      emptyAfterRead: emptyAfterRead,
      repairAttempted: repairAttempted,
      repairRecovered: repairRecovered,
      emptyAfterRepair: emptyAfterRepair,
      elapsedMs: Date.now() - startedAt,
    },
  };
})()`;
}
