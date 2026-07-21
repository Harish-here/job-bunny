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
  const idAttrName = inv.behaviors.jobCardIdAttr ?? null;
  return `(() => {
  const cardListSel = ${JSON.stringify(sel.cardList)};
  const cardSel = ${JSON.stringify(sel.card)};
  const titleSel = ${JSON.stringify(sel.cardTitle)};
  const companySel = ${JSON.stringify(sel.cardCompany)};
  const locationSel = ${JSON.stringify(sel.cardLocation)};
  const linkSel = ${JSON.stringify(sel.cardLink)};
  const idAttrName = ${JSON.stringify(idAttrName)};
  const text = (el) => (el && el.textContent ? el.textContent.trim() : '');
  const listEl = document.querySelector(cardListSel);
  const cardEls = listEl ? Array.from(listEl.querySelectorAll(cardSel)) : [];
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
