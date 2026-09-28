/**
 * Pure per-row/per-state validation for the "Where jobs come from"
 * section's search-URL editor — extracted out of
 * `WhereJobsComeFromSection.tsx` so that component stays under its
 * file-size cap. No React: task 23's orchestrator is the only caller.
 *
 * task 1's classifier (`classifyLinkedInSearchUrl`) is the single source of
 * "is this a recognized LinkedIn search link" — the old HOST_MESSAGE branch
 * is gone. PROTOCOL_MESSAGE (ux-notes C4: "keeps the protocol error") stays,
 * imported from task 19's `searchUrlRow.classify` rather than duplicated
 * locally. `validateSearchUrlRows`'s return feeds `saveState.errors`/
 * `ValidationSummary` only — the inline `FieldError` under each row comes
 * from `classifyRowsForDisplay` (task 19/20) via the component's own
 * `displayStates`.
 */
import { classifyLinkedInSearchUrl } from '../../../../../src/core/linkedin_url/index.ts';
import {
  buildValidationSummaryRefusalMessage,
  PROTOCOL_MESSAGE,
} from './searchUrlRow.classify';
import type { SearchUrlRow } from './searchUrls.model';

export const LABEL_MESSAGE = 'Give this search a short label.';

function validateRow(row: SearchUrlRow): string | undefined {
  const url = row.url.trim();
  if (url === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return PROTOCOL_MESSAGE;
  }
  if (parsed.protocol !== 'https:') return PROTOCOL_MESSAGE;
  try {
    classifyLinkedInSearchUrl(url);
  } catch {
    return buildValidationSummaryRefusalMessage(row.label);
  }
  if (row.label.trim() === '') return LABEL_MESSAGE;
  return undefined;
}

// Keyed `where-jobs-search-urls.{i}` — the lanes card has nothing to
// validate (a checkbox is valid by construction).
export function validateSearchUrlRows(rows: SearchUrlRow[]): Record<string, string> {
  const errors: Record<string, string> = {};
  rows.forEach((row, i) => {
    const message = validateRow(row);
    if (message) errors[`where-jobs-search-urls.${i}`] = message;
  });
  return errors;
}
