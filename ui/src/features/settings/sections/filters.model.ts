export type TitleRuleKey = 'domain' | 'function' | 'seniority';
export type WorkType = 'onsite' | 'hybrid' | 'remote';
export type Severity = 'hard' | 'soft';

export interface FilterMatchRule {
  match: string[];
  reject: string[];
  severity: Severity;
}
export interface FilterLocation {
  city: string;
  country: string; // '' means "not set" in the editor
  workTypes: WorkType[];
}
export interface FilterSkills {
  core: string[];
  minMatch: number;
  severity: Severity;
}
export interface FilterEditorState {
  title: Record<TitleRuleKey, FilterMatchRule>;
  locations: FilterLocation[];
  skills: FilterSkills;
}

export const TITLE_RULE_KEYS: TitleRuleKey[] = ['domain', 'function', 'seniority'];
const WORK_TYPES: WorkType[] = ['onsite', 'hybrid', 'remote'];

function emptyRule(): FilterMatchRule {
  return { match: [], reject: [], severity: 'hard' };
}
function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}
function parseRule(raw: unknown): FilterMatchRule {
  if (raw == null || typeof raw !== 'object') return emptyRule();
  const r = raw as Record<string, unknown>;
  return {
    match: asStringArray(r.match),
    reject: asStringArray(r.reject),
    severity: r.severity === 'soft' ? 'soft' : 'hard',
  };
}
function parseWorkTypes(raw: unknown): WorkType[] {
  return asStringArray(raw).filter((w): w is WorkType =>
    (WORK_TYPES as string[]).includes(w),
  );
}
function parseLocation(raw: unknown): FilterLocation | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    city: typeof r.city === 'string' ? r.city : '',
    country: typeof r.country === 'string' ? r.country : '',
    workTypes: parseWorkTypes(r.workTypes),
  };
}

// Reads a possibly-partial filter.json object into the editor's shape,
// defaulting every owned field. `companies` and `timezones` are never
// read here — they are preserved by applyFilterEditorState simply never
// touching them (see Rationale), never by copying them through here.
export function parseFilterDoc(raw: Record<string, unknown>): FilterEditorState {
  const rawTitle = (raw.title as Record<string, unknown> | undefined) ?? {};
  const title = {} as Record<TitleRuleKey, FilterMatchRule>;
  for (const key of TITLE_RULE_KEYS) title[key] = parseRule(rawTitle[key]);

  const rawLocations = Array.isArray(raw.locations) ? raw.locations : [];
  const locations = rawLocations
    .map(parseLocation)
    .filter((l): l is FilterLocation => l != null);

  const rawSkills = (raw.skills as Record<string, unknown> | undefined) ?? {};
  const minMatch = typeof rawSkills.minMatch === 'number' ? rawSkills.minMatch : 1;
  const skills: FilterSkills = {
    core: asStringArray(rawSkills.core),
    minMatch,
    severity: rawSkills.severity === 'soft' ? 'soft' : 'hard',
  };
  return { title, locations, skills };
}

// locations[i].workTypes empty, locations[i].city empty, and
// skills.minMatch below 1 are the only invalid editor states — every
// chip is a plain non-empty string by construction, so nothing else
// can be invalid.
export function validateFilterEditorState(
  state: FilterEditorState,
): Record<string, string> {
  const errors: Record<string, string> = {};
  state.locations.forEach((loc, i) => {
    if (loc.city.trim() === '') errors[`locations.${i}.city`] = 'Enter a city.';
    if (loc.workTypes.length === 0)
      errors[`locations.${i}.workTypes`] = 'Pick at least one work type.';
  });
  if (!Number.isInteger(state.skills.minMatch) || state.skills.minMatch < 1) {
    errors['skills.minMatch'] =
      'Minimum skill matches must be a whole number of 1 or more.';
  }
  return errors;
}

// Applies title/locations/skills onto a parsed filter.json object IN
// PLACE, assigning exactly those three keys — companies and timezones
// are never referenced, so whatever the caller's object already holds
// there survives untouched.
export function applyFilterEditorState(
  current: Record<string, unknown>,
  state: FilterEditorState,
): void {
  const title: Record<string, unknown> = {};
  for (const key of TITLE_RULE_KEYS) {
    const rule = state.title[key];
    title[key] = { match: rule.match, reject: rule.reject, severity: rule.severity };
  }
  current.title = title;
  current.locations = state.locations.map((loc) => ({
    city: loc.city,
    country: loc.country === '' ? undefined : loc.country,
    workTypes: loc.workTypes,
  }));
  current.skills = {
    core: state.skills.core,
    minMatch: state.skills.minMatch,
    severity: state.skills.severity,
  };
}
