import type { RunContext } from '../../../../ports/context.ts';
import type { Inventory } from '../inventory.ts';

/** PURE — builds the url for page `pageIndex` (1-based) of a paginated
 * LinkedIn search. Page 1 returns `baseUrl` byte-unchanged — no `start=0`
 * is ever added, matching the pre-pagination behavior exactly. Page N>=2
 * sets/overrides the query param named by `param` to
 * `(pageIndex - 1) * pageSize`, via the WHATWG URL API so every other
 * query param already on `baseUrl` is preserved untouched. */
export function buildPageUrl(
  baseUrl: string,
  pageIndex: number,
  param: string,
  pageSize: number,
): string {
  if (pageIndex <= 1) return baseUrl;
  const url = new URL(baseUrl);
  url.searchParams.set(param, String((pageIndex - 1) * pageSize));
  return url.toString();
}

/** Parsed pagination behaviors off a page inventory (`behaviors.
 * paginationType/paginationParam/paginationPageSize/maxPages` — all
 * inventory-declared strings, `inventory.ts`'s `InventorySchema` keeps
 * `behaviors` as a free-form string record). Falls back to a single page
 * (the exact pre-pagination behavior) whenever `paginationType` isn't
 * `"url-pages"` or any needed field is missing/unparseable, rather than
 * guessing a default range. */
export interface PaginationConfig {
  param: string;
  pageSize: number;
  maxPages: number;
}

export const SINGLE_PAGE_PAGINATION: PaginationConfig = {
  param: 'start',
  pageSize: 0,
  maxPages: 1,
};

export function resolvePagination(inv: Inventory, ctx: RunContext): PaginationConfig {
  const b = inv.behaviors;
  if (b.paginationType !== 'url-pages') return SINGLE_PAGE_PAGINATION;
  const param = b.paginationParam;
  const pageSize = Number.parseInt(b.paginationPageSize ?? '', 10);
  const maxPages = Number.parseInt(b.maxPages ?? '', 10);
  if (
    !param ||
    !Number.isFinite(pageSize) ||
    pageSize <= 0 ||
    !Number.isFinite(maxPages) ||
    maxPages <= 0
  ) {
    ctx.logger.debug(
      'linkedin lane: pagination behaviors missing/unparseable — treating url as single-page',
      { page: inv.page },
    );
    return SINGLE_PAGE_PAGINATION;
  }
  return { param, pageSize, maxPages };
}

/** PURE — true when two harvested-card id sets are identical (order-
 * independent). Detects LinkedIn repeating its last page of results once
 * `start` overshoots the true result count — the same id/link key
 * (`HarvestedCard.id`) the run-dedup Set (`processedIds`) uses. */
export function sameCardIdSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}
