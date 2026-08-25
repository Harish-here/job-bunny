/**
 * "Roles & companies" screen's pure data layer (blueprint.md:729-747, step
 * 13) — mirrors `filters.model.ts`'s own parse-doc / apply-editor-state
 * shape, but spans TWO documents (filter.json's `title` + `companies.avoid`,
 * profile.json's `settings.rank.title.domainKeywords` /
 * `.seniority.targets`) rather than one. `title` is reused verbatim from
 * `parseFilterDoc` (same posture as `whereYouWork.model.ts` reusing that
 * function's `locations` field) rather than re-parsed here — one parser per
 * raw field, never two.
 *
 * Scope boundary (R8): `settings.rank.title.maxPoints`/`.neutralPoints` and
 * `settings.rank.seniority.maxPoints` are point weights, not list fields —
 * this module reads them only to preserve them untouched on write (spread,
 * never overwritten); editing them stays exclusively on the Raw config
 * section. Only `domainKeywords`, `seniority.targets`, `companies.avoid`
 * and `title` are ever assigned here.
 */

import type { FilterMatchRule, TitleRuleKey } from './filters.model';
import { parseFilterDoc, TITLE_RULE_KEYS } from './filters.model';

export interface RolesCompaniesEditorState {
  /** Rules card — filter.json's `title` (domain/function/seniority match +
   * reject + severity), reused unchanged from FiltersSection's own
   * `TitleRuleEditor`. */
  title: Record<TitleRuleKey, FilterMatchRule>;
  /** Preferences card — profile.json's `settings.rank.title.domainKeywords`.
   * Currently unsurfaced anywhere else in the UI. */
  domainKeywords: string[];
  /** Preferences card — profile.json's `settings.rank.seniority.targets`.
   * Currently unsurfaced anywhere else in the UI. */
  seniorityTargets: string[];
  /** Companies-to-avoid card — filter.json's `companies.avoid`. A
   * deliberate pass-through per `filters.model.ts`'s own doc comment; this
   * section is the first to read/write it. */
  companiesAvoid: string[];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

function parseCompaniesAvoid(raw: unknown): string[] {
  if (raw == null || typeof raw !== 'object') return [];
  return asStringArray((raw as Record<string, unknown>).avoid);
}

// Reads a possibly-partial (filter.json, profile.json) pair into the
// editor's combined shape. Reuses filters.model.ts's parseFilterDoc for
// `title` rather than re-parsing it, same rationale as
// whereYouWork.model.ts's own parseWhereYouWorkDoc.
export function parseRolesCompaniesDoc(
  filterRaw: Record<string, unknown>,
  profileRaw: Record<string, unknown>,
): RolesCompaniesEditorState {
  const { title } = parseFilterDoc(filterRaw);
  const companiesAvoid = parseCompaniesAvoid(filterRaw.companies);

  const settings = (profileRaw.settings as Record<string, unknown> | undefined) ?? {};
  const rank = (settings.rank as Record<string, unknown> | undefined) ?? {};
  const rankTitle = (rank.title as Record<string, unknown> | undefined) ?? {};
  const rankSeniority = (rank.seniority as Record<string, unknown> | undefined) ?? {};

  return {
    title,
    companiesAvoid,
    domainKeywords: asStringArray(rankTitle.domainKeywords),
    seniorityTargets: asStringArray(rankSeniority.targets),
  };
}

/** Which raw doc a given `applyRolesCompaniesEditorState` call targets — a
 * single exported apply function (mirroring filters.model.ts's own
 * parse-doc/apply-editor-state PAIR), parameterized by target rather than
 * split into two exports, since `useDocForm.save()` only ever hands this
 * function ONE doc's current parsed value at a time. */
export type RolesCompaniesDocTarget = 'filter' | 'profile';

// Applies the editor state onto ONE parsed raw doc IN PLACE, touching only
// the fields this screen owns for that doc — everything else the caller's
// object already holds survives untouched (same posture as
// filters.model.ts's applyFilterEditorState / whereYouWork.model.ts's pair
// of apply functions).
export function applyRolesCompaniesEditorState(
  target: RolesCompaniesDocTarget,
  current: Record<string, unknown>,
  state: RolesCompaniesEditorState,
): void {
  if (target === 'filter') {
    const title: Record<string, unknown> = {};
    for (const key of TITLE_RULE_KEYS) {
      const rule = state.title[key];
      title[key] = { match: rule.match, reject: rule.reject, severity: rule.severity };
    }
    current.title = title;
    current.companies = {
      ...((current.companies as Record<string, unknown> | undefined) ?? {}),
      avoid: state.companiesAvoid,
    };
    return;
  }

  const settings = {
    ...((current.settings as Record<string, unknown> | undefined) ?? {}),
  };
  const rank = { ...((settings.rank as Record<string, unknown> | undefined) ?? {}) };
  rank.title = {
    ...((rank.title as Record<string, unknown> | undefined) ?? {}),
    domainKeywords: state.domainKeywords,
  };
  rank.seniority = {
    ...((rank.seniority as Record<string, unknown> | undefined) ?? {}),
    targets: state.seniorityTargets,
  };
  settings.rank = rank;
  current.settings = settings;
}
