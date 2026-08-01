import type { TrackingPatchBody, TrackingRow } from '../../lib/api/types';

/**
 * Local mirror of the server's tracking-patch semantics (ports/board.ts):
 * a null field clears it, an absent field keeps it, a value overwrites it.
 * Used for the optimistic update; the server's TrackingRow replaces this
 * on success, and the pre-patch snapshot restores it on failure.
 */
export function applyPatch(
  existing: TrackingRow | null,
  jobId: string,
  patch: TrackingPatchBody,
): TrackingRow {
  const base: TrackingRow = existing ?? { jobId, updatedAt: '' };
  // Field-level merge over an index-typed copy: TrackingPatchBody's keys are
  // a subset of TrackingRow's, but TS cannot correlate the two per-key.
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as unknown as TrackingRow;
}
