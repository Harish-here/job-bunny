/**
 * core/linkedin_url — classify + clean a LinkedIn jobs-search URL (spec R1).
 * Dependency-free (zero imports, plain global `URL`) so `ui/` can import it
 * per CLAUDE.md's ui→core seam exception. This module owns the canonical
 * copy of `lane_add_url.ts`'s `EPHEMERAL`/`resolvePage` logic — ported
 * unchanged here; a later step deletes the original and delegates to this
 * module instead of duplicating it.
 */

/** Recognized LinkedIn jobs-search page slugs, matching the inventory
 * filenames under `src/adapters/lanes/linkedin/page_inventory/`. */
export type LinkedInSearchUrlPage =
  | 'linkedin__jobs-search'
  | 'linkedin__jobs-search-results';

export interface LinkedInSearchUrlClassification {
  page: LinkedInSearchUrlPage;
  label: string;
  cleanedUrl: string;
  removedParams: string[];
}

/** Thrown for anything that isn't a recognized LinkedIn jobs-search link —
 * a parse failure, an unrecognized host, or a recognized host with an
 * unrecognized path. `.url` always carries the raw, unmodified input so a
 * caller can name it back to the user. */
export class UnrecognizedLinkedInSearchUrlError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(
      `refused: ${url} — not a LinkedIn jobs search link (expected /jobs/search, ` +
        `/jobs/search-results or /jobs/collections/…). Nothing written.`,
    );
    this.name = 'UnrecognizedLinkedInSearchUrlError';
    this.url = url;
  }
}

/** Single source for the UX §2 vocabulary table. */
export const LINKEDIN_SEARCH_URL_LABELS: Record<LinkedInSearchUrlPage, string> = {
  'linkedin__jobs-search': 'Jobs search',
  'linkedin__jobs-search-results': 'Search results',
};

// Ephemeral params that change per click/session/alert — stripped so the same search
// dedups. "start" is a pagination offset, not a filter — always reset to beginning.
// Ported unchanged from `lane_add_url.ts:43-54` (this module owns the canonical copy).
const EPHEMERAL_PARAMS = [
  'currentJobId',
  'referralSearchId',
  'origin',
  'originToLandingJobPostings',
  'savedSearchId',
  'alertAction',
  'trackingId',
  'refId',
  'eBP',
  'start',
];

/** Ported unchanged from `lane_add_url.ts:112-127`'s matching logic. Throws
 * `UnrecognizedLinkedInSearchUrlError` (naming the raw input) for anything
 * with no known mapping. */
function isLinkedInHost(hostname: string): boolean {
  return hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com');
}

function resolvePage(u: URL, rawUrl: string): LinkedInSearchUrlPage {
  const validScheme = u.protocol === 'https:' || u.protocol === 'http:';
  if (validScheme && isLinkedInHost(u.hostname)) {
    if (
      /^\/jobs\/search\/?$/.test(u.pathname) ||
      u.pathname.startsWith('/jobs/collections/')
    ) {
      return 'linkedin__jobs-search';
    }
    if (/^\/jobs\/search-results\/?$/.test(u.pathname)) {
      return 'linkedin__jobs-search-results';
    }
  }
  throw new UnrecognizedLinkedInSearchUrlError(rawUrl);
}

/** Classifies a LinkedIn jobs-search URL to its page type and strips
 * ephemeral per-click/session/alert query params (spec R1). Throws
 * `UnrecognizedLinkedInSearchUrlError` for anything that isn't a
 * recognized LinkedIn jobs-search link — a parse failure, an unrecognized
 * host, or a recognized host with an unrecognized path. Nothing is
 * written by this function; it only classifies and cleans. */
export function classifyLinkedInSearchUrl(
  rawUrl: string,
): LinkedInSearchUrlClassification {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new UnrecognizedLinkedInSearchUrlError(rawUrl);
  }

  const page = resolvePage(u, rawUrl);

  const removedParams: string[] = [];
  for (const p of EPHEMERAL_PARAMS) {
    if (u.searchParams.has(p)) {
      u.searchParams.delete(p);
      removedParams.push(p);
    }
  }

  // A relative window (`r<seconds>`, e.g. `r86400`) is a real filter and stays; an
  // absolute anchor (`a<epoch>-`, a per-alert "posted after this exact moment" stamp)
  // goes stale on a recurring search and is stripped.
  const tpr = u.searchParams.get('f_TPR');
  if (tpr && /^a\d+/.test(tpr)) {
    u.searchParams.delete('f_TPR');
    removedParams.push('f_TPR');
  }

  return {
    page,
    label: LINKEDIN_SEARCH_URL_LABELS[page],
    cleanedUrl: u.toString(),
    removedParams,
  };
}
