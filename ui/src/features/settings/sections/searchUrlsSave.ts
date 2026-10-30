/**
 * Save-orchestration pure helpers for the "Where jobs come from" section's
 * search-URL editor (spec R9/R10) — extracted out of
 * `WhereJobsComeFromSection.tsx` so that component stays under its
 * file-size cap. No React, no fetch: task 23's orchestrator is the only
 * caller.
 */
import { classifyLinkedInSearchUrl } from '../../../../../src/core/linkedin_url/index.ts';
import type { SearchUrlsSaveReport } from '../../../lib/api/types';
import {
  buildValidationSummaryRefusalMessage,
  type RowDisplay,
} from './searchUrlRow.classify';
import { parseSearchUrlRows, type SearchUrlRow } from './searchUrls.model';

/** Thin wrapper around `parseSearchUrlRows`. Every row parsed from a
 * server response is, by definition, already correctly filed and clean
 * (the server just normalized it) — so every row comes back `touched:
 * true`, matching the mockup's Default-state loaded rows. */
export function reseedRowsFromText(text: string): SearchUrlRow[] {
  return parseSearchUrlRows(text).map((row) => ({ ...row, touched: true }));
}

/** ux-notes §3's clause order: re-filed, cleaned, merged; zero-count
 * clauses dropped; "Saved N search links." alone when nothing changed.
 * ux-notes §10's literal example capitalizes ONLY the first clause after
 * the base sentence's period — every clause is built lowercase below,
 * then the first one alone is capitalized at the join step. */
export function buildSearchUrlsSuccessMessage(report: SearchUrlsSaveReport): string {
  const clauses: string[] = [];
  if (report.refiled > 0) clauses.push(`re-filed ${report.refiled}`);
  if (report.cleaned > 0) clauses.push(`cleaned ${report.cleaned}`);
  if (report.merged > 0) {
    clauses.push(`merged ${report.merged} duplicate${report.merged === 1 ? '' : 's'}`);
  }
  const base = `Saved ${report.total} search link${report.total === 1 ? '' : 's'}.`;
  if (clauses.length === 0) return base;
  // `ui/tsconfig.json`'s `noUncheckedIndexedAccess: true` makes
  // `[first, ...rest] = clauses` type `first` as `string | undefined`
  // (clauses is `string[]`, not a tuple) — `.map()`'s callback parameter
  // is typed from the array's element type directly, unaffected by
  // noUncheckedIndexedAccess, so capitalizing via `.map((clause, i) => ...)`
  // sidesteps a possibly-undefined head entirely.
  const capitalized = clauses.map((clause, i) =>
    i === 0 ? clause.charAt(0).toUpperCase() + clause.slice(1) : clause,
  );
  return `${base} ${capitalized.join(', ')}.`;
}

/** `serverMessage` (BE's `refused: <url> — ...` wire string) is used ONLY
 * to find WHICH row the server refused — it is never the text shown to
 * the user. The displayed value is always
 * `buildValidationSummaryRefusalMessage`, built from the matched row's
 * OWN label, matching every other ValidationSummary entry's shape.
 *
 * `noUncheckedIndexedAccess` makes `rows[index]` type as `SearchUrlRow |
 * undefined` — `.find()` returns the matched element directly, already
 * `| undefined`-typed and safe to optional-chain, no indexed access at
 * all. */
export function mergeServerRefusal(
  clientErrors: Record<string, string>,
  rows: SearchUrlRow[],
  serverMessage: string,
): Record<string, string> {
  const matchedRow = rows.find(
    (row) => row.url !== '' && serverMessage.includes(row.url),
  );
  const index = matchedRow ? rows.indexOf(matchedRow) : -1;
  const key = index === -1 ? 'search-urls.server' : `where-jobs-search-urls.${index}`;
  const label = matchedRow?.label ?? ''; // buildValidationSummaryRefusalMessage's own '' → 'This link' fallback covers the no-match case too
  return { ...clientErrors, [key]: buildValidationSummaryRefusalMessage(label) };
}

/** B3 (QA search-link-intake): the ONLY condition under which a failed
 * search-urls save routes through `mergeServerRefusal` into a row-level
 * FieldError/ValidationSummary entry — `serverMessage` (the wire-format
 * `refused: <url> — ...` string) must name a URL that matches one of the
 * CURRENT rows. Every other failure (a 5xx, a network error, or a 422 that
 * doesn't name a current row — e.g. rows changed since the request was
 * sent) is a general save error instead; the caller renders that as a
 * plain alert, never a row error. Shared by both the Save and Re-file
 * paths, since both PUT through the same mutation. */
export function matchesRowRefusal(rows: SearchUrlRow[], serverMessage: string): boolean {
  return rows.some((row) => row.url !== '' && serverMessage.includes(row.url));
}

export interface SearchUrlsSaveErrorSplit {
  validationErrors: Record<string, string>;
  /** Non-null exactly when `error` is set and `matchesRowRefusal` is
   * false — the caller renders this as a plain, general save-error alert
   * (never routed through `ValidationSummary`). */
  generalError: string | null;
}

const GENERAL_SAVE_ERROR_MESSAGE =
  "Couldn't save search links. Check your connection and try again.";

/** B3 orchestration (QA search-link-intake): the one place that decides
 * "row error vs general error" for a failed search-urls save/re-file —
 * extracted out of `WhereJobsComeFromSection.tsx` for the same file-size
 * reason as every other helper in this file. `error` is `searchUrlsMutation
 * .error` (or `null` when nothing has failed); `clientErrors` is
 * `saveState.errors`, passed through unchanged whenever there's no
 * server-side refusal to merge in. */
export function splitSearchUrlsSaveError(
  clientErrors: Record<string, string>,
  rows: SearchUrlRow[],
  error: Error | null,
): SearchUrlsSaveErrorSplit {
  if (error === null) return { validationErrors: clientErrors, generalError: null };
  if (matchesRowRefusal(rows, error.message)) {
    return {
      validationErrors: mergeServerRefusal(clientErrors, rows, error.message),
      generalError: null,
    };
  }
  return { validationErrors: clientErrors, generalError: GENERAL_SAVE_ERROR_MESSAGE };
}

/** R13 Re-file (spec R13): rewrites every `misfiled` row's `page` to its
 * classification's own `page` — and `url` to `cleanedUrl` too, when the
 * row is ALSO dirty. Every OTHER row (including `duplicate`/`clean`/
 * `cleaned`/`refused`/`unclassified`) passes through unchanged; the
 * caller is responsible for PUTting the result and reseeding from the
 * mutation's OWN resolved response (never this function's return) — a
 * re-file can itself trigger a merge, the same PUT-echo fix class as a
 * normal save. */
export function buildRefiledRows(
  rows: SearchUrlRow[],
  displayStates: RowDisplay[],
): SearchUrlRow[] {
  return rows.map((row, i) => {
    const display = displayStates[i];
    if (display?.kind !== 'misfiled') return row;
    try {
      const classification = classifyLinkedInSearchUrl(row.url);
      return { ...row, page: classification.page, url: classification.cleanedUrl };
    } catch {
      return { ...row, page: display.page };
    }
  });
}
