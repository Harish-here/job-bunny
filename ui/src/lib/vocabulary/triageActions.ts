import type { DecideAction } from '../../features/triage/decide.ts';

/**
 * Display labels for the triage decide actions (R11 — no raw jargon like
 * "Skip" in the UI). Byte-exact keys match `DecideAction`; the stored
 * tracking-status strings this maps to live in `decide.ts`'s
 * `DECIDE_STATUS`, which is itself byte-exact against `STATUS_OPTIONS`
 * (`src/core/tracking/vocab.ts`) — these labels are display-only.
 */
export const TRIAGE_ACTION_LABELS = {
  apply: 'Apply',
  save: 'Lead',
  skip: 'Pass',
} as const satisfies Record<DecideAction, string>;
