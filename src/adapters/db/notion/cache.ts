/**
 * Notion cache rebuild (P7 Task 4). Ports v0's `scripts/notion/cache.js`
 * `reconcile()`: paginate the live DB, one `CacheEntry` per page. Strictly
 * READ-ONLY on Notion (`NotionApi.queryDatabase` only) — the cache mirror is
 * always rebuildable from the live DB and never itself a source of truth.
 *
 * Inputs: an already-constructed `NotionApi`, the target database id, and a
 * `RunContext` (signal/logger passed straight through to the API client).
 * Output: `CacheEntry[]` (see `ports/connector.ts`) — `id` (derived from the
 * Job URL, since the DB has no job_id column — mirrors v0's
 * `extractJobId`/`dedupKey`, re-prefixed to match v2's lane-prefixed
 * `identity.id` convention: `li-`/`gh-`/`kk-`), `company`, `title`, `pageId`,
 * and `city` (v0 header amendment — populated from Location City so
 * `dedup.repost` can tell two same-title/company jobs in different cities
 * apart; absent when the row has no Location City value).
 *
 * Invariant: a failure throws PLAINLY (never wrapped in `SoftError`) — a
 * partial cache must never look like a successful rebuild. `queryDatabase`
 * itself already never wraps (see client.ts), so this file adds no new
 * error handling of its own; it just shapes the raw pages.
 */

import type { CacheEntry } from '../../../ports/connector.ts';
import type { RunContext } from '../../../ports/context.ts';
import type { NotionApi } from './client.ts';
import { PROPERTIES } from './schema.ts';

/** The narrow slice of a real Notion page's `properties` values this module
 * reads — title/rich_text/url are the only property types `CacheEntry`
 * needs (mirrors v0 cache.js's inline property readers). */
interface RawPropertyValue {
  title?: { plain_text: string }[];
  rich_text?: { plain_text: string }[];
  url?: string | null;
}

interface RawPage {
  id: string;
  properties?: Record<string, RawPropertyValue | undefined>;
}

function plainText(parts: { plain_text: string }[] | undefined): string {
  return (parts ?? []).map((t) => t.plain_text).join('');
}

function propText(p: RawPropertyValue | undefined): string {
  if (p?.title) return plainText(p.title);
  if (p?.rich_text) return plainText(p.rich_text);
  return '';
}

function propUrl(p: RawPropertyValue | undefined): string | null {
  return p?.url ?? null;
}

/** Derives a v2-shaped `identity.id` (`li-`/`gh-`/`kk-` prefixed) from a Job
 * URL — the closest available port of v0's `extractJobId`, re-prefixed so a
 * cache entry's `id` can be compared directly against a fresh JD's
 * `identity.id` in `dedup.id` (see lane `id` construction in
 * greenhouse/keka/linkedin's `lane.ts`/`harvest.ts`). Returns '' when the
 * URL doesn't match any known lane shape — `dedup.ts` already treats a
 * falsy `CacheEntry.id` as "no id to index", same as v0 tolerating a
 * non-derivable job_id. */
function deriveId(url: string | null): string {
  if (!url) return '';
  const linkedin = url.match(/\/jobs\/view\/([^/?#]+)/);
  if (linkedin) return `li-${linkedin[1]}`;
  const ghQuery = url.match(/[?&]gh_jid=(\d+)/);
  if (ghQuery) return `gh-${ghQuery[1]}`;
  if (url.includes('greenhouse.io/')) {
    const gh = url.match(/\/jobs\/(\d+)(?:[/?#]|$)/);
    if (gh) return `gh-${gh[1]}`;
  }
  if (url.includes('.keka.com/')) {
    const kk = url.match(/\/careers\/jobdetails\/(\d+)(?:[/?#]|$)/);
    if (kk) return `kk-${kk[1]}`;
  }
  return '';
}

function pageToEntry(raw: unknown): CacheEntry {
  const page = raw as RawPage;
  const props = page.properties ?? {};
  const jobUrl = propUrl(props[PROPERTIES.jobUrl.name]);
  const city = propText(props[PROPERTIES.locationCity.name]);
  return {
    id: deriveId(jobUrl),
    company: propText(props[PROPERTIES.company.name]),
    title: propText(props[PROPERTIES.jobTitle.name]),
    pageId: page.id,
    ...(city ? { city } : {}),
  };
}

/** Rebuilds the cache from the live DB — pagination is entirely
 * `NotionApi.queryDatabase`'s job; this just maps each raw page to a
 * `CacheEntry`. */
export async function rebuildCache(
  api: NotionApi,
  dbId: string,
  ctx: RunContext,
): Promise<CacheEntry[]> {
  const pages = await api.queryDatabase(dbId, ctx);
  return pages.map(pageToEntry);
}
