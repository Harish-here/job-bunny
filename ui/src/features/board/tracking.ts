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

export interface CommitDeps {
  read: () => TrackingRow | null;
  patch: (patch: TrackingPatchBody) => Promise<TrackingRow>;
  apply: (tracking: TrackingRow | null) => void;
}

/**
 * Runs one field edit end-to-end: no-op guard, optimistic apply, server
 * PATCH, and — on failure — a FIELD-LEVEL rollback computed against the
 * row as it stands at failure time, so a concurrent edit's confirmed
 * value is never discarded (a whole-row snapshot would resurrect it).
 * Returns null on success or no-op, the error message on failure.
 */
export async function commitField(
  jobId: string,
  field: keyof TrackingPatchBody,
  raw: string,
  deps: CommitDeps,
): Promise<string | null> {
  const before = deps.read();
  const previous = before?.[field];
  if (raw === (previous ?? '') || (raw.trim() === '' && (previous ?? '') === '')) return null;
  const value = raw.trim() === '' ? null : raw;
  // Cast erases the status literal union — safe: the select's options come
  // from /meta (the server vocab), and the server 400s anything else, which
  // rolls back below.
  const patch = { [field]: value } as TrackingPatchBody;
  deps.apply(applyPatch(before, jobId, patch));
  try {
    const confirmed = await deps.patch(patch);
    deps.apply(confirmed);
    return null;
  } catch (err) {
    const rollback = { [field]: previous === undefined ? null : previous } as TrackingPatchBody;
    deps.apply(applyPatch(deps.read(), jobId, rollback));
    return err instanceof Error ? err.message : String(err);
  }
}
