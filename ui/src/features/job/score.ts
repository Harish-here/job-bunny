/**
 * The pane's 4-tier match-score band (`ux-notes.md` §1, judgment call 3):
 * `< 50` Weak (1 bar) · `50–69` Fair (2 bars) · `70–84` Good (3 bars) ·
 * `≥ 85` Strong (4 bars). Distinct from the row-level 3-tier weight band
 * (`ux-notes.md` §6, `JobRow.tsx`'s own inline score text) — do not merge
 * the two threshold sets.
 */
export type ScoreBand = 'Strong' | 'Good' | 'Fair' | 'Weak';

export function scoreBand(score: number): ScoreBand {
  if (score >= 85) return 'Strong';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Fair';
  return 'Weak';
}

const SEGMENTS_BY_BAND: Record<ScoreBand, number> = {
  Strong: 4,
  Good: 3,
  Fair: 2,
  Weak: 1,
};

/** How many of the 4 meter bars are filled for a given score (R15: the band
 * is legible from bar count alone, colour is layered on top only). */
export function scoreSegments(score: number): number {
  return SEGMENTS_BY_BAND[scoreBand(score)];
}
