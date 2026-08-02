import type { BoardJobRow } from '../../lib/api/types';

/**
 * Triage's decide mapping (spec decision, not the vocab's own authority —
 * see CLAUDE.md's tracking vocab, `src/core/tracking/vocab.ts` — these
 * three values are byte-exact against `STATUS_OPTIONS`). Apply → `Applied`,
 * Skip → `Passed`, Save → `Lead`.
 */
export const DECIDE_STATUS = {
  apply: 'Applied',
  skip: 'Passed',
  save: 'Lead',
} as const;

export type DecideAction = keyof typeof DECIDE_STATUS;

/**
 * Finds the next undecided row (`tracking?.status == null`) strictly after
 * `fromId` in list order, wrapping around to earlier rows; `null` when no
 * row is undecided (including when `fromId` is the only undecided row —
 * it was just decided, so it no longer counts).
 */
export function nextUndecided(rows: BoardJobRow[], fromId: string | null): string | null {
  if (rows.length === 0) return null;
  const fromIndex = fromId === null ? -1 : rows.findIndex((row) => row.id === fromId);
  // No current row to exclude (nothing selected, or the id is gone from the
  // list): search from the top instead of skipping the first entry.
  if (fromIndex === -1) {
    return rows.find((row) => row.tracking?.status == null)?.id ?? null;
  }
  for (let offset = 1; offset < rows.length; offset++) {
    const row = rows[(fromIndex + offset) % rows.length];
    if (row && row.tracking?.status == null) return row.id;
  }
  return null;
}
