/**
 * "Where you'll work" screen's pure data layer (blueprint.md:673-682, step
 * 10) — the cross-document timezone conflict check between filter.json's
 * accept list and profile.json's rank-config timezone lists. Corrected
 * 4-branch logic per blueprint-be §0(a). No rendering surface of its own —
 * WhereYouWorkSection.tsx (task 11) consumes computeTimezoneConflict to
 * drive the section's `geo-conflict-notice` alert, and the parse/validate/
 * apply functions below (added by task 11, same file/module — this doc
 * layer owns the whole screen's data, not just the conflict check) to
 * drive its two-card read-modify-write flow across BOTH filter.json and
 * profile.json.
 */
import { normalizeToken } from '../../../../../src/core/normalize_token/index.ts';
import { type FilterLocation, parseFilterDoc } from './filters.model';

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

// ---------------------------------------------------------------------
// Editor-state layer (task 11). The screen spans TWO documents:
// filter.json (Rules card: locations + timezones.{accept,severity}) and
// profile.json's settings.rank.location / settings.rank.workTypePreference
// (Preferences card). WhereYouWorkSection.tsx holds ONE combined draft of
// this shape and applies it back onto each raw doc separately at save time.
// ---------------------------------------------------------------------

/** Simplified 2-option control backing profile.json's numeric
 * `workTypePreference: {onsite,hybrid,remote}` multiplier record — the
 * mockup's own select only offers "Remote first" / "No preference", so a
 * continuous 3-way weight space is deliberately collapsed to a binary
 * choice here (see whereYouWork.model.test.ts for the exact weights this
 * maps to/from). */
export type WorkTypePreferenceOption = 'remote-first' | 'no-preference';

export interface WhereYouWorkEditorState {
  /** Rules card — filter.json's `locations[]`, reusing FilterLocation
   * (filters.model.ts) unchanged since WhereYouWorkSection reuses
   * FiltersSection's own LocationRow to edit it. */
  locations: FilterLocation[];
  /** Rules card — filter.json's `timezones` block. `undefined` means the
   * profile has never configured a timezone rule at all (see
   * FilterTimezones's own doc comment) — preserved through the whole
   * edit flow, not defaulted to an empty object, so computeTimezoneConflict
   * keeps returning `[]` for a profile that never opted into this rule. */
  timezonesRule: FilterTimezones | undefined;
  /** Preferences card — profile.json's settings.rank.location fields. */
  homeCities: string[];
  acceptableTimezones: string[];
  borderlineTimezones: string[];
  workTypePreference: WorkTypePreferenceOption;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

function parseTimezonesRule(raw: unknown): FilterTimezones | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  return {
    accept: asStringArray(r.accept),
    severity: r.severity === 'soft' ? 'soft' : 'hard',
  };
}

/** "Remote first" -> remote weighted 2x onsite/hybrid, mirroring this same
 * axis's own existing bonus(20)/partial(10) 2:1 ratio (core/rank/rank.ts) —
 * "No preference" is the schema's own all-1 default. A profile with any
 * other hand-edited ratio (only reachable via Raw config or `jobbunny
 * config set`) reads back as "No preference" here; Raw config is where
 * that finer control lives (see the Preferences card's own footer link). */
function parseWorkTypePreference(raw: unknown): WorkTypePreferenceOption {
  if (raw == null || typeof raw !== 'object') return 'no-preference';
  const r = raw as Record<string, unknown>;
  const remote = typeof r.remote === 'number' ? r.remote : 1;
  const onsite = typeof r.onsite === 'number' ? r.onsite : 1;
  const hybrid = typeof r.hybrid === 'number' ? r.hybrid : 1;
  return remote > onsite && remote > hybrid ? 'remote-first' : 'no-preference';
}

function workTypePreferenceWeights(option: WorkTypePreferenceOption): {
  onsite: number;
  hybrid: number;
  remote: number;
} {
  return option === 'remote-first'
    ? { onsite: 1, hybrid: 1, remote: 2 }
    : { onsite: 1, hybrid: 1, remote: 1 };
}

// Reads a possibly-partial (filter.json, profile.json) pair into the
// editor's combined shape. Reuses filters.model.ts's parseFilterDoc for
// `locations` rather than re-parsing it — same rationale as
// FiltersSection's own doc comment: one parser per raw field, never two.
export function parseWhereYouWorkDoc(
  filterRaw: Record<string, unknown>,
  profileRaw: Record<string, unknown>,
): WhereYouWorkEditorState {
  const { locations } = parseFilterDoc(filterRaw);
  const timezonesRule = parseTimezonesRule(filterRaw.timezones);

  const settings = (profileRaw.settings as Record<string, unknown> | undefined) ?? {};
  const rank = (settings.rank as Record<string, unknown> | undefined) ?? {};
  const location = (rank.location as Record<string, unknown> | undefined) ?? {};

  return {
    locations,
    timezonesRule,
    homeCities: asStringArray(location.homeCities),
    acceptableTimezones: asStringArray(location.acceptableTimezones),
    borderlineTimezones: asStringArray(location.borderlineTimezones),
    workTypePreference: parseWorkTypePreference(rank.workTypePreference),
  };
}

// The Rules card's locations are the only field this screen validates —
// same two rules FiltersSection already enforces per location (a chip is a
// non-empty string by construction, so nothing else on this screen can be
// invalid). Keyed `where-you-work-locations.{i}.*` (distinct from
// FiltersSection's own `locations.{i}.*` keys) since a future screen could
// render both sections' SaveBars in the same DOM tree.
export function validateWhereYouWorkEditorState(
  state: WhereYouWorkEditorState,
): Record<string, string> {
  const errors: Record<string, string> = {};
  state.locations.forEach((loc, i) => {
    if (loc.city.trim() === '')
      errors[`where-you-work-locations.${i}.city`] = 'Enter a city.';
    if (loc.workTypes.length === 0)
      errors[`where-you-work-locations.${i}.workTypes`] = 'Pick at least one work type.';
  });
  return errors;
}

// Applies the Rules-card fields onto a parsed filter.json object IN PLACE,
// touching only `locations`/`timezones` — title/companies/skills are never
// referenced, so whatever the caller's object already holds there survives
// untouched (same posture as filters.model.ts's applyFilterEditorState).
export function applyWhereYouWorkFilterState(
  current: Record<string, unknown>,
  state: WhereYouWorkEditorState,
): void {
  current.locations = state.locations.map((loc) => ({
    city: loc.city,
    country: loc.country === '' ? undefined : loc.country,
    workTypes: loc.workTypes,
  }));
  if (state.timezonesRule === undefined) {
    delete current.timezones;
  } else {
    current.timezones = {
      accept: state.timezonesRule.accept,
      severity: state.timezonesRule.severity,
    };
  }
}

// Applies the Preferences-card fields onto a parsed profile.json object IN
// PLACE, touching only settings.rank.location.{homeCities,acceptable
// Timezones,borderlineTimezones} and settings.rank.workTypePreference —
// every sibling settings.rank.* field (skills, title, seniority, yoe,
// softVerdictPenalty, location.bonus/partial) and every other top-level key
// survives untouched.
export function applyWhereYouWorkProfileState(
  current: Record<string, unknown>,
  state: WhereYouWorkEditorState,
): void {
  const settings = {
    ...((current.settings as Record<string, unknown> | undefined) ?? {}),
  };
  const rank = { ...((settings.rank as Record<string, unknown> | undefined) ?? {}) };
  const location = { ...((rank.location as Record<string, unknown> | undefined) ?? {}) };
  rank.location = {
    ...location,
    homeCities: state.homeCities,
    acceptableTimezones: state.acceptableTimezones,
    borderlineTimezones: state.borderlineTimezones,
  };
  rank.workTypePreference = workTypePreferenceWeights(state.workTypePreference);
  settings.rank = rank;
  current.settings = settings;
}
