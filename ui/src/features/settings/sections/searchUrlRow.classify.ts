/**
 * Pure per-row display classification for the Settings search-url row
 * editor (spec R4/R9/R10). No I/O, no mutation — the row's URL/page are
 * never rewritten here; that happens in the blur handler (task 23).
 */
import {
  classifyLinkedInSearchUrl,
  type LinkedInSearchUrlPage,
} from '../../../../../src/core/linkedin_url/index.ts';
import type { SearchUrlRow } from './searchUrls.model';

/** ux-notes.md C4's exact copy — the ONLY text ever shown as the inline
 * FieldError under a refused search-url row, whether the refusal was
 * caught client-side (below) or server-side (task 22's mergeServerRefusal,
 * task 23). A BE `UnrecognizedLinkedInSearchUrlError`/422 message is never
 * displayed verbatim — it is wire format, used only to identify which
 * row a server-side refusal belongs to. */
export const FIELD_ERROR_COPY =
  "This isn't a LinkedIn jobs search link. Paste one from linkedin.com/jobs/search, " +
  '/jobs/search-results or /jobs/collections.';

/** ux-notes.md §3's ValidationSummary copy ("Zafin — not a LinkedIn jobs
 * search link"), label-prefixed, shorter than FIELD_ERROR_COPY. `label`
 * falls back to `'This link'` when the row's Label field is still empty. */
export function buildValidationSummaryRefusalMessage(label: string): string {
  return `${label.trim() || 'This link'} — not a LinkedIn jobs search link`;
}

/** ux-notes.md C4's own text: "It replaces the old host error and keeps
 * the protocol error." — lifted UNCHANGED from the pre-existing
 * `SearchUrlsSection.tsx`/`WhereJobsComeFromSection.tsx` `PROTOCOL_MESSAGE`
 * constant. Distinct from FIELD_ERROR_COPY: shown only when the URL
 * doesn't even parse as an absolute URL, or isn't `https:` — a narrower,
 * earlier check than "is this recognized as a LinkedIn jobs link", run
 * BEFORE calling classifyLinkedInSearchUrl. */
export const PROTOCOL_MESSAGE = 'Enter a LinkedIn URL starting with https://';

export type RowDisplay =
  | { kind: 'unclassified' }
  | { kind: 'refused'; message: string }
  | { kind: 'clean'; page: LinkedInSearchUrlPage; label: string }
  | {
      kind: 'cleaned';
      page: LinkedInSearchUrlPage;
      label: string;
      removedParams: string[];
    }
  | { kind: 'misfiled'; page: LinkedInSearchUrlPage; label: string; storedPage: string }
  | {
      kind: 'duplicate';
      page: LinkedInSearchUrlPage;
      label: string;
      mergesIntoLabel: string;
    };

type Interim =
  | { kind: 'unclassified' }
  | { kind: 'refused'; message: string }
  | {
      kind: 'ok';
      page: LinkedInSearchUrlPage;
      label: string;
      removedParams: string[];
      key: string;
    };

function classifyOne(row: SearchUrlRow): Interim {
  if (!row.touched || row.url.trim() === '') {
    return { kind: 'unclassified' };
  }

  let parsed: URL;
  try {
    parsed = new URL(row.url);
  } catch {
    return { kind: 'refused', message: PROTOCOL_MESSAGE };
  }
  if (parsed.protocol !== 'https:') {
    return { kind: 'refused', message: PROTOCOL_MESSAGE };
  }

  try {
    const classification = classifyLinkedInSearchUrl(row.url);
    return {
      kind: 'ok',
      page: classification.page,
      label: row.label,
      removedParams: classification.removedParams,
      key: `${classification.page}|${classification.cleanedUrl}`,
    };
  } catch {
    // The classifier's own thrown message is discarded entirely for
    // display purposes — used only as a boolean "is this recognized"
    // signal. FIELD_ERROR_COPY is the only text ever shown.
    return { kind: 'refused', message: FIELD_ERROR_COPY };
  }
}

/** Precedence, one row is exactly one display kind: 1) duplicate — a row
 * whose `page|cleanedUrl` key was already seen by an EARLIER row in array
 * order; 2) else misfiled if `classification.page !== row.page`; 3) else
 * cleaned if `removedParams.length > 0`; 4) else clean. Mirrors BE task
 * 2's own dedupe key exactly (first-occurrence-wins). */
export function classifyRowsForDisplay(rows: SearchUrlRow[]): RowDisplay[] {
  const interim = rows.map(classifyOne);
  const firstSeenIndex = new Map<string, number>();

  return interim.map((item, i) => {
    if (item.kind === 'unclassified') {
      return { kind: 'unclassified' };
    }
    if (item.kind === 'refused') {
      return { kind: 'refused', message: item.message };
    }

    const seenAt = firstSeenIndex.get(item.key);
    if (seenAt === undefined) {
      firstSeenIndex.set(item.key, i);
    } else {
      const first = interim[seenAt];
      const mergesIntoLabel = first?.kind === 'ok' ? first.label : item.label;
      return {
        kind: 'duplicate',
        page: item.page,
        label: item.label,
        mergesIntoLabel,
      };
    }

    const row = rows[i];
    if (row && item.page !== row.page) {
      return {
        kind: 'misfiled',
        page: item.page,
        label: item.label,
        storedPage: row.page,
      };
    }

    if (item.removedParams.length > 0) {
      return {
        kind: 'cleaned',
        page: item.page,
        label: item.label,
        removedParams: item.removedParams,
      };
    }

    return { kind: 'clean', page: item.page, label: item.label };
  });
}
