import type {
  AboutAnswers,
  Persona,
  PersonaRule,
  WizardLocation,
  WorkType,
} from './wizard.types';

export interface MatchRule {
  match: string[];
  reject: string[];
  severity: 'hard' | 'soft';
}

export interface DerivedLocation {
  city: string;
  country?: string;
  workTypes: WorkType[];
}

export interface DerivedFilter {
  title?: {
    domain?: MatchRule;
    function?: MatchRule;
    seniority?: MatchRule;
  };
  locations?: DerivedLocation[];
}

/** Lowercases every term and drops later duplicates, keeping the first
 * occurrence's position — used for both persona rule terms and picked
 * seniority terms. */
function lowerDedupe(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const lower = term.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(lower);
    }
  }
  return out;
}

function ruleFromPersonaRule(rule: PersonaRule): MatchRule | undefined {
  const match = lowerDedupe(rule.match);
  const reject = lowerDedupe(rule.reject);
  return match.length === 0 && reject.length === 0
    ? undefined
    : { match, reject, severity: 'hard' };
}

function seniorityRule(seniority: string[]): MatchRule | undefined {
  const match = lowerDedupe(seniority);
  return match.length === 0 ? undefined : { match, reject: [], severity: 'hard' };
}

/** Key order (domain, function, seniority) is fixed by spread order, not by
 * which sub-rules happen to be present — every spread of an absent rule
 * contributes zero keys, so the surviving keys always appear in this order. */
function buildTitle(
  domain: MatchRule | undefined,
  func: MatchRule | undefined,
  seniority: MatchRule | undefined,
): DerivedFilter['title'] {
  if (domain == null && func == null && seniority == null) return undefined;
  return {
    ...(domain == null ? {} : { domain }),
    ...(func == null ? {} : { function: func }),
    ...(seniority == null ? {} : { seniority }),
  };
}

function toDerivedLocation(loc: WizardLocation, workTypes: WorkType[]): DerivedLocation {
  const city = loc.city.trim();
  const country = loc.country.trim();
  return country === '' ? { city, workTypes } : { city, country, workTypes };
}

/** FilterConfigSchema requires locations[].workTypes to have at least one
 * member (src/core/filter/config.ts) — a half-filled entry would fail the
 * server's own validation, so the whole block is omitted rather than risk
 * emitting one. */
function buildLocations(about: AboutAnswers): DerivedLocation[] | undefined {
  if (about.workTypes.length === 0) return undefined;
  const withCity = about.locations.filter((loc) => loc.city.trim() !== '');
  if (withCity.length === 0) return undefined;
  return withCity.map((loc) => toDerivedLocation(loc, about.workTypes));
}

export function deriveFilter(input: {
  persona: Persona | null;
  about: AboutAnswers;
}): DerivedFilter {
  const { persona, about } = input;
  const domain = persona == null ? undefined : ruleFromPersonaRule(persona.title.domain);
  const func = persona == null ? undefined : ruleFromPersonaRule(persona.title.function);
  const seniority = seniorityRule(about.seniority);
  const title = buildTitle(domain, func, seniority);
  const locations = buildLocations(about);

  return {
    ...(title == null ? {} : { title }),
    ...(locations == null ? {} : { locations }),
  };
}
