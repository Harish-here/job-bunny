/**
 * "Where you'll work" screen's pure data layer (blueprint.md:673-682, step
 * 10) — the cross-document timezone conflict check between filter.json's
 * accept list and profile.json's rank-config timezone lists. Corrected
 * 4-branch logic per blueprint-be §0(a). No rendering surface — task 11
 * consumes this to drive the section's `geo-conflict-notice` alert.
 */
import { normalizeToken } from '../../../../../src/core/normalize_token/index.ts';

export type TimezoneSeverity = 'hard' | 'soft';

/** filter.json's `timezones` block. `undefined` means the profile has
 * never configured a timezone rule at all. */
export interface FilterTimezones {
  accept: string[];
  severity: TimezoneSeverity;
}

/** profile.json's `settings.rank.location` timezone lists — the rank
 * config's own opinion of which timezones the candidate will work,
 * independent of whether filter.json's accept list agrees with it. */
export interface RankLocationTimezones {
  acceptableTimezones: string[];
  borderlineTimezones: string[];
}

export interface TimezoneConflict {
  tz: string;
  severity: TimezoneSeverity;
}

/**
 * Diffs profile.json's rank-config timezone lists (acceptableTimezones +
 * borderlineTimezones, unioned) against filter.json's timezones.accept
 * list, both sides normalized via normalizeToken so casing/punctuation
 * differences never cause a false conflict.
 *
 * Branch 1 — filterTimezones is undefined: return [] ALWAYS, regardless of
 * what the rank lists contain. When there is no timezone rule at all there
 * is nothing to conflict with; a naive set-difference against an empty
 * accept list would otherwise fire a false positive on every profile that
 * simply never configured a timezone rule.
 *
 * Branches 3 and 4 are deliberately NOT collapsed into one shared path
 * that only varies the returned string: under filterTimezones.severity
 * === 'hard' the job is DROPPED by the filter stage; under 'soft' it is
 * kept and rank-penalised instead. Those are materially different
 * pipeline outcomes, and task 11's UI branches its copy on this field —
 * collapsing the branches would erase a distinction downstream code
 * depends on.
 */
export function computeTimezoneConflict(
  filterTimezones: FilterTimezones | undefined,
  rankLocation: RankLocationTimezones,
): TimezoneConflict[] {
  // Branch 1: no timezone rule configured at all -> nothing can conflict.
  if (filterTimezones === undefined) return [];

  const accept = new Set(filterTimezones.accept.map(normalizeToken));
  // "unioned": de-dupe the two rank lists before testing membership, so a
  // timezone listed in both acceptableTimezones and borderlineTimezones
  // doesn't produce two conflict entries.
  const rankTimezones = Array.from(
    new Set([...rankLocation.acceptableTimezones, ...rankLocation.borderlineTimezones]),
  );

  const conflicts: TimezoneConflict[] = [];
  for (const tz of rankTimezones) {
    if (accept.has(normalizeToken(tz))) continue;
    if (filterTimezones.severity === 'hard') {
      // Branch 3: absent from accept, hard severity -> dropped.
      conflicts.push({ tz, severity: 'hard' });
    } else {
      // Branch 4: absent from accept, soft severity -> rank-penalised,
      // NOT dropped. Kept as a separate branch from above — see the
      // function doc comment for why.
      conflicts.push({ tz, severity: 'soft' });
    }
  }
  return conflicts;
}
