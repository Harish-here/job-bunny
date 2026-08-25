/**
 * Landing screen's pure data layer (blueprint.md:559-585, step 9a). A thin
 * Landing-specific AGGREGATOR over `ui/src/features/runs/runResult.ts`'s
 * existing exports — NOT a second `RunResult`-shaped module. Every value
 * this screen needs (`jobsIn`, `jobsOut`, `dropsByRule`) already exists
 * there; this file only reshapes it for Landing's three read-only blocks.
 */
import { getBiggestDrop, getFunnelStages, newMatchCount } from '../../runs/runResult';

// --- (1) thin-run summary ---

export interface ThinRunSummary {
  /** The first funnel stage's `jobsIn`, or `null` when `getFunnelStages`
   * itself returns `null` (no run yet / a malformed result blob). Never a
   * fabricated `0` — `0` means "zero jobs scraped", `null` means "we don't
   * know", and the five-state inventory exists precisely to keep those
   * apart. */
  scraped: number | null;
  onBoard: number;
  biggestDrop: { stage: string; rule: string; count: number } | null;
}

export function thinRunSummary(result: unknown): ThinRunSummary {
  const stages = getFunnelStages(result);
  const first = stages?.[0];
  return {
    scraped: stages === null ? null : (first?.jobsIn ?? null),
    onBoard: newMatchCount(result),
    biggestDrop: getBiggestDrop(stages ?? []),
  };
}

// --- (2) caps in force (4-row caps table) ---

export interface ProfileCapSettings {
  maxNewPerLane: number;
  maxProbesPerRun: number;
  maxCardsPerUrl: number;
  maxAgeDays: number;
}

/** The extended soft-errors response's `capsHit` field
 * (`SoftErrorSummary.capsHit`, `src/app/features/runs/soft_errors.ts`) —
 * `undefined` when no run has been fetched yet (e.g. a profile with no
 * runs, or the query hasn't loaded). Note there is deliberately no signal
 * for `maxProbesPerRun` on this shape today — see `hit: null` below. */
export interface CapsHitSignal {
  maxNewPerLane: boolean;
  maxCardsPerUrl: boolean;
}

export interface CapRow {
  name: 'maxNewPerLane' | 'maxProbesPerRun' | 'maxCardsPerUrl' | 'maxAgeDays';
  value: number;
  /** `true`/`false` is a real, known signal. `null` means "no signal
   * exists" and must NEVER be presented as a confident "not hit" — see the
   * per-row rationale below. */
  hit: boolean | null;
}

/** Exactly four rows, fixed order. `capsHit` is `undefined` before any run
 * has been observed — both of its own fields degrade to `hit: null` in
 * that case (no signal yet is the same "we don't know" class as no signal
 * at all, never presented as a false "not hit"). */
export function capsInForce(
  profileSettings: ProfileCapSettings,
  capsHit: CapsHitSignal | undefined,
): CapRow[] {
  return [
    {
      name: 'maxNewPerLane',
      value: profileSettings.maxNewPerLane,
      hit: capsHit?.maxNewPerLane ?? null,
    },
    // No signal exists for maxProbesPerRun on the extended soft-errors
    // response today — `null` unconditionally, never inferred from any
    // other field.
    { name: 'maxProbesPerRun', value: profileSettings.maxProbesPerRun, hit: null },
    {
      name: 'maxCardsPerUrl',
      value: profileSettings.maxCardsPerUrl,
      hit: capsHit?.maxCardsPerUrl ?? null,
    },
    // maxAgeDays gates LinkedIn page-inventory freshness, not yield (F10)
    // — "hit/not hit" isn't a meaningful concept for it, so `null`
    // unconditionally, never computed from any signal.
    { name: 'maxAgeDays', value: profileSettings.maxAgeDays, hit: null },
  ];
}

// --- (3) rules in force (3-row rules table) ---

export type RuleGroup = 'roles-companies' | 'where-you-work' | 'skills';

export interface RuleRow {
  group: RuleGroup;
  activeCount: number;
  hardCount: number;
}

interface RawTitleRule {
  match?: unknown;
  reject?: unknown;
  severity?: unknown;
}
interface RawFilterDoc {
  title?: Record<string, RawTitleRule | undefined>;
  locations?: unknown[];
  skills?: { core?: unknown; severity?: unknown };
}

const TITLE_KEYS = ['domain', 'function', 'seniority'] as const;

function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Counting rule per group (this brief's own DECIDE call — the blueprint
 * only worked an example for `roles-companies`):
 *
 * - `roles-companies`: iterate the three `title` keys (`domain`,
 *   `function`, `seniority`). A key counts as one active rule when its
 *   `match` OR `reject` array is non-empty. `hardCount` counts only the
 *   active keys whose `severity === 'hard'`.
 * - `where-you-work`: `activeCount` is `locations.length` (each location
 *   entry is one active rule). `hardCount` equals `activeCount` — a
 *   `FilterLocation` (see `filters.model.ts`) carries no per-entry
 *   severity field at all, so every present location is inherently hard
 *   (matched or the job is dropped — there is no soft variant in the
 *   current schema). `timezones` is deliberately NOT folded in here: the
 *   blueprint's wording for this row is "locations-derived," singular.
 * - `skills`: `activeCount` is `skills.core.length`. `hardCount` equals
 *   `activeCount` when `skills.severity === 'hard'`, else `0` —
 *   `FilterSkills` carries one severity for the whole block, not
 *   per-skill, so either every core skill counts as hard or none do.
 */
export function rulesInForce(
  filterDoc: RawFilterDoc,
  // Unused today — every counted value lives on `filterDoc`. Kept in the
  // signature per this brief's own contract; `profileDoc` may become
  // relevant to a future row this brief does not add.
  _profileDoc: Record<string, unknown>,
): RuleRow[] {
  const title = filterDoc.title ?? {};
  let rolesActive = 0;
  let rolesHard = 0;
  for (const key of TITLE_KEYS) {
    const rule = title[key];
    if (!rule) continue;
    const active = isNonEmptyArray(rule.match) || isNonEmptyArray(rule.reject);
    if (!active) continue;
    rolesActive += 1;
    if (rule.severity === 'hard') rolesHard += 1;
  }

  const locations = Array.isArray(filterDoc.locations) ? filterDoc.locations : [];
  const locationsCount = locations.length;

  const skillsCore = Array.isArray(filterDoc.skills?.core) ? filterDoc.skills?.core : [];
  const skillsCount = skillsCore?.length ?? 0;
  const skillsHard = filterDoc.skills?.severity === 'hard' ? skillsCount : 0;

  return [
    { group: 'roles-companies', activeCount: rolesActive, hardCount: rolesHard },
    { group: 'where-you-work', activeCount: locationsCount, hardCount: locationsCount },
    { group: 'skills', activeCount: skillsCount, hardCount: skillsHard },
  ];
}
