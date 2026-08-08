import type { CardInput } from '../../../../core/filter/rules/types.ts';
import type { DroppedRecord } from '../../../../core/jd/index.ts';
import type { PageHandle } from '../../../../ports/browser.ts';
import type { RunContext } from '../../../../ports/context.ts';
import type { Inventory } from '../inventory.ts';
import { buildHarvestScript, type HarvestDiag, type RawCard } from './script.ts';

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
 * so existing importers (adapters/lanes/linkedin/cards/index.ts) keep working. */
export type { DroppedRecord };

const DEFAULT_HARVEST_TIMEOUT_MS = 20_000;
/** Bounded wait for the results list to attach before the in-page read.
 * Matches v0's DEFAULT_CALL_TIMEOUT_MS in scripts/pipeline/extract/cards.js. */
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const JOB_ID_RE = /\/jobs\/view\/(\d+)/;
const LINKEDIN_ORIGIN = 'https://www.linkedin.com';

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
  const read = await page.evaluate<{ cards: RawCard[]; diag: HarvestDiag }>(script, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_HARVEST_TIMEOUT_MS,
  });
  // One line per page, debug level: this is how the residual "why did a
  // page fail to mount at all?" question gets answered from production
  // data instead of another live probe.
  ctx.logger.debug('harvest: card read diagnostics', { page: inv.page, ...read.diag });
  const raw = read.cards;

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
