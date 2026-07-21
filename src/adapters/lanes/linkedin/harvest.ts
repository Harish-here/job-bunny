import type { FilterConfig } from '../../../core/filter/config.ts';
import { decide, evaluateCard } from '../../../core/filter/engine.ts';
import type { CardInput } from '../../../core/filter/rules/types.ts';
import { type JD, JDSchema, type Verdict } from '../../../core/jd/index.ts';
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

/** Mirrors pipeline/runner/stage.ts's DroppedRecord shape structurally —
 * NOT imported from there: adapters may only depend on ports + core
 * (boundaries rule 'adapters-only-ports-core'). */
export interface DroppedRecord {
  jd: JD;
  reasons: Verdict[];
}

interface RawCard {
  title: string;
  company: string;
  location: string;
  href: string;
}

const DEFAULT_HARVEST_TIMEOUT_MS = 15_000;
const JOB_ID_RE = /\/jobs\/view\/(\d+)/;
const LINKEDIN_ORIGIN = 'https://www.linkedin.com';

/**
 * Builds the in-page harvest function as a SOURCE STRING (an IIFE
 * expression) rather than a JS function value — PageHandle.evaluate takes a
 * string so it can be sent to the page over CDP. Pure and unit-testable in
 * isolation via node:vm against a fake `document`.
 */
export function buildHarvestScript(inv: Inventory): string {
  const sel = inv.selectors;
  return `(() => {
  const cardListSel = ${JSON.stringify(sel.cardList)};
  const cardSel = ${JSON.stringify(sel.card)};
  const titleSel = ${JSON.stringify(sel.cardTitle)};
  const companySel = ${JSON.stringify(sel.cardCompany)};
  const locationSel = ${JSON.stringify(sel.cardLocation)};
  const linkSel = ${JSON.stringify(sel.cardLink)};
  const text = (el) => (el && el.textContent ? el.textContent.trim() : '');
  const listEl = document.querySelector(cardListSel);
  const cardEls = listEl ? Array.from(listEl.querySelectorAll(cardSel)) : [];
  return cardEls.map((el) => {
    const linkEl = el.querySelector(linkSel);
    return {
      title: text(el.querySelector(titleSel)),
      company: text(el.querySelector(companySel)),
      location: text(el.querySelector(locationSel)),
      href: linkEl ? linkEl.getAttribute('href') || '' : '',
    };
  });
})()`;
}

/**
 * Single batch in-page read of every visible card, mapped to typed
 * HarvestedCards. Never per-card round trips (2026-07-17 stall lesson —
 * see memory). Cards whose href doesn't carry a parseable LinkedIn job id
 * are skipped with a warn — a malformed card must not kill the harvest.
 */
export async function harvestCards(
  page: PageHandle,
  inv: Inventory,
  ctx: RunContext,
  opts: { timeoutMs?: number } = {},
): Promise<HarvestedCard[]> {
  const script = buildHarvestScript(inv);
  const raw = await page.evaluate<RawCard[]>(script, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_HARVEST_TIMEOUT_MS,
  });

  const cards: HarvestedCard[] = [];
  for (const item of raw) {
    const match = JOB_ID_RE.exec(item.href);
    if (!match) {
      ctx.logger.warn('harvest: skipping card with unparseable href', {
        href: item.href,
        title: item.title,
      });
      continue;
    }
    cards.push({
      title: item.title,
      company: item.company,
      location: item.location || undefined,
      url: new URL(item.href, LINKEDIN_ORIGIN).toString(),
      id: `li-${match[1]}`,
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
