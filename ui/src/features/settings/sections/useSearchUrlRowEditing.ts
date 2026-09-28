import { useRef } from 'react';
import { classifyLinkedInSearchUrl } from '../../../../../src/core/linkedin_url/index.ts';
import type { SearchUrlRow } from './searchUrls.model';

export interface SearchUrlRowEditing {
  onBlurUrl: (index: number) => void;
  /** `isPaste` mirrors `SearchUrlRow`'s own `InputEvent.inputType ===
   * 'insertFromPaste'` gate — an ordinary keystroke just updates the raw
   * url; a detected paste runs the same classify-and-rewrite `onBlurUrl`
   * runs, immediately rather than waiting for blur. */
  onChangeUrl: (index: number, url: string, isPaste?: boolean) => void;
  /** Looked up by the caller's own `displayStates` derivation for a row
   * `classifyRowsForDisplay` itself reports as `'clean'` — see
   * `WhereJobsComeFromSection.tsx`'s doc comment for why a plain 'clean'
   * classification still needs this override to show a "Cleaned" note. */
  getRecentlyCleaned: (index: number, page: string, url: string) => string[] | undefined;
  clearRecentlyCleaned: () => void;
}

/**
 * The search-URL row editor's classify-on-blur/paste behaviour (ux-notes
 * §6), extracted out of `WhereJobsComeFromSection.tsx` purely for that
 * file's size cap — no behaviour change beyond the B7/B8 fixes documented
 * below (QA search-link-intake). `rows`/`updateRow` are the caller's own
 * editor state; this hook owns no state of its own beyond the
 * `recentlyCleaned` bookkeeping map.
 */
export function useSearchUrlRowEditing(
  rows: SearchUrlRow[],
  updateRow: (index: number, patch: Partial<SearchUrlRow>) => void,
): SearchUrlRowEditing {
  // classifyAndRewrite (below) rewrites `row.url` to its OWN cleaned form
  // on success — so re-classifying that already-clean value a moment
  // later always finds zero removedParams and reports 'clean', never
  // 'cleaned': the "what got removed" signal is otherwise lost the
  // instant the rewrite lands. Keyed by the row's OWN index at the
  // rewrite moment plus its `page|cleanedUrl` (B8 fix: a PLAIN
  // `page|cleanedUrl` key collides whenever a dirty duplicate cleans down
  // to an EARLIER row's already-clean url, which then wrongly bled the
  // "Cleaned" note onto that earlier, never-rewritten row too). A stale
  // entry is simply never looked up again once a row's url moves on to a
  // different key, or the row is removed.
  const recentlyCleaned = useRef<Map<string, string[]>>(new Map());

  // B7 fix (QA search-link-intake): a REFUSED paste must not mark the row
  // `touched` yet (ux-notes §6: "the refused error waits for blur or
  // Save") — `classifyRowsForDisplay` reports 'unclassified' (no error)
  // for an untouched row, so leaving `touched` alone here keeps the row
  // silent until `onBlurUrl` re-runs this same function WITHOUT
  // `isPaste`, which does mark it touched. A refusal reached via blur (or
  // Save-time revalidation) still marks touched immediately, unchanged.
  function classifyAndRewrite(index: number, url: string, isPaste = false) {
    try {
      const classification = classifyLinkedInSearchUrl(url);
      if (classification.removedParams.length > 0) {
        recentlyCleaned.current.set(
          `${index}|${classification.page}|${classification.cleanedUrl}`,
          classification.removedParams,
        );
      }
      updateRow(index, {
        url: classification.cleanedUrl,
        page: classification.page,
        touched: true,
      });
    } catch {
      updateRow(index, isPaste ? { url } : { url, touched: true });
    }
  }

  return {
    onBlurUrl(index) {
      const row = rows[index];
      if (!row) return;
      classifyAndRewrite(index, row.url);
    },
    onChangeUrl(index, url, isPaste) {
      if (isPaste) {
        classifyAndRewrite(index, url, true);
        return;
      }
      updateRow(index, { url });
    },
    getRecentlyCleaned(index, page, url) {
      return recentlyCleaned.current.get(`${index}|${page}|${url}`);
    },
    clearRecentlyCleaned() {
      recentlyCleaned.current.clear();
    },
  };
}
