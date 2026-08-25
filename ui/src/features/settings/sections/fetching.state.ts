/**
 * `FetchingSection`'s pure state shape, parsing, and validation — split out
 * of `FetchingSection.tsx` once that file crossed the 400-line cap (task
 * 28 gap fix). No React here; `FetchingSection.tsx` is the only importer,
 * matching `fetching.model.ts`'s own sibling role for the preset mapping.
 */

export interface FetchingState {
  maxNewPerLane: number;
  maxProbesPerRun: number;
  maxCardsPerUrl: number;
  maxAgeDays: number;
  jitterMinMs: number;
  jitterMaxMs: number;
  interUrlDelayMinMs: number;
  interUrlDelayMaxMs: number;
}

// Same shipped defaults `LandingCapsTable.tsx`/`core/config/linkedin_pacing/
// index.ts` use — a profile with no `settings` block at all still shows the
// real in-force numbers, never a blank/zero.
export const DEFAULTS: FetchingState = {
  maxNewPerLane: 40,
  maxProbesPerRun: 25,
  maxCardsPerUrl: 40,
  maxAgeDays: 30,
  jitterMinMs: 5_000,
  jitterMaxMs: 12_000,
  interUrlDelayMinMs: 20_000,
  interUrlDelayMaxMs: 45_000,
};

export const EMPTY_STATE: FetchingState = DEFAULTS;

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

// Mirrors `LandingCapsTable.tsx`'s own resolver posture: anything other
// than a positive finite number falls back to the shipped default rather
// than a wrong/blank field.
export function parseFetchingState(profileDoc: Record<string, unknown>): FetchingState {
  const settings = asRecord(profileDoc.settings);
  const source = asRecord(settings.source);
  const linkedin = asRecord(settings.linkedin);
  return {
    maxNewPerLane: positiveNumber(source.maxNewPerLane, DEFAULTS.maxNewPerLane),
    maxProbesPerRun: positiveNumber(source.maxProbesPerRun, DEFAULTS.maxProbesPerRun),
    maxCardsPerUrl: positiveNumber(linkedin.maxCardsPerUrl, DEFAULTS.maxCardsPerUrl),
    maxAgeDays: positiveNumber(linkedin.maxAgeDays, DEFAULTS.maxAgeDays),
    jitterMinMs: positiveNumber(linkedin.jitterMinMs, DEFAULTS.jitterMinMs),
    jitterMaxMs: positiveNumber(linkedin.jitterMaxMs, DEFAULTS.jitterMaxMs),
    interUrlDelayMinMs: positiveNumber(
      linkedin.interUrlDelayMinMs,
      DEFAULTS.interUrlDelayMinMs,
    ),
    interUrlDelayMaxMs: positiveNumber(
      linkedin.interUrlDelayMaxMs,
      DEFAULTS.interUrlDelayMaxMs,
    ),
  };
}

export interface CapFieldDef {
  key: 'maxNewPerLane' | 'maxProbesPerRun' | 'maxCardsPerUrl' | 'maxAgeDays';
  dataQa: string;
  bounds: string;
  min: number;
  max: number;
  effect: (value: number) => string;
  /** Only `maxNewPerLane`/`maxCardsPerUrl` have a real hit signal on the
   * soft-errors response (`SoftErrorSummary.capsHit`) — `maxProbesPerRun`
   * and `maxAgeDays` never render the binding-marker clause. */
  hitKey: 'maxNewPerLane' | 'maxCardsPerUrl' | null;
}

export const CAP_FIELDS: CapFieldDef[] = [
  {
    key: 'maxNewPerLane',
    dataQa: 'fetch-cap-max-new-per-lane',
    bounds: '1–500',
    min: 1,
    max: 500,
    effect: (v) => `At most ${v} new jobs from each lane per run.`,
    hitKey: 'maxNewPerLane',
  },
  {
    key: 'maxProbesPerRun',
    dataQa: 'fetch-cap-max-probes-per-run',
    bounds: '1–200',
    min: 1,
    max: 200,
    effect: (v) => `At most ${v} ATS probes per run.`,
    hitKey: null,
  },
  {
    key: 'maxCardsPerUrl',
    dataQa: 'fetch-cap-max-cards-per-url',
    bounds: '1–200',
    min: 1,
    max: 200,
    effect: (v) => `At most ${v} cards read per saved-search URL.`,
    hitKey: 'maxCardsPerUrl',
  },
  {
    key: 'maxAgeDays',
    dataQa: 'fetch-cap-max-age-days',
    bounds: '1–90',
    min: 1,
    max: 90,
    // Gates LinkedIn page-inventory freshness — NEVER "limits job count" (F10).
    effect: (v) => `Postings older than ${v} days are skipped.`,
    hitKey: null,
  },
];

export function validateState(state: FetchingState): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of CAP_FIELDS) {
    const value = state[field.key];
    if (!Number.isFinite(value) || value < field.min || value > field.max) {
      errors[`fetching.${field.key}`] =
        `${field.key} must be between ${field.min} and ${field.max}.`;
    }
  }
  return errors;
}

// Cross-field pacing invariants (R13, spec.md:590) — mirrors the wire-time
// pair `core/config/linkedin_pacing/index.ts`'s `LinkedinPacingSettingsSchema`
// already enforces (`jitterMinMs <= jitterMaxMs`, `interUrlDelayMinMs <=
// interUrlDelayMaxMs`). Deliberately NOT folded into `validateState`/
// `useSectionSaveState`'s own `errors` (which are live on every keystroke,
// per `WhereJobsComeFromSection`'s already-shipped "invalid URL surfaces
// the validation summary" contract, itself intentional and covered) —
// R13's own wording is "the error shown at submit — not as-you-type, and
// never by disabling the save button" (spec.md:590/754). A live cross-field
// check here would do the opposite: the summary would replace the Save
// button (`SaveBar`'s own documented priority order) the instant the first
// of the two fields goes out of range, before the user ever reaches Save —
// exactly the "disabling the save button" R13 rules out, just achieved by
// unmounting it instead of a `disabled` attribute. Checked instead inside
// `FetchingSection.tsx`'s own `handleSave`, at the actual submit attempt
// (task 28 gap fix) — the write is skipped entirely (no PUT sent) rather
// than round-tripping to the server's own wire-time reject, but the check
// is IDENTICAL either way, so no config `handleSave` accepts here could
// ever have failed the server.
const RAW_PACING_PAIRS: Array<{
  minKey: 'jitterMinMs' | 'interUrlDelayMinMs';
  maxKey: 'jitterMaxMs' | 'interUrlDelayMaxMs';
  minLabel: string;
  maxLabel: string;
}> = [
  {
    minKey: 'jitterMinMs',
    maxKey: 'jitterMaxMs',
    minLabel: 'Minimum jitter',
    maxLabel: 'maximum jitter',
  },
  {
    minKey: 'interUrlDelayMinMs',
    maxKey: 'interUrlDelayMaxMs',
    minLabel: 'Minimum time between searches',
    maxLabel: 'maximum time between searches',
  },
];

function capitalizeFirst(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function lowercaseFirst(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

export interface PacingPairErrors {
  /** Full sentence per field, for `ValidationSummary` — B12 fix (QA
   * settings-overhaul, round 2): the max field now gets ITS OWN sentence
   * ("Maximum jitter (...) is below minimum jitter (...)"), not a copy of
   * the min field's. Previously both entries of a failing pair carried the
   * identical min-phrased sentence, which rendered as the same sentence
   * twice under "2 problems to fix" — mockup S8 gives each field its own. */
  summary: Record<string, string>;
  /** Short form per field, for the inline `FieldError` under each raw
   * input — B12 fix: mockup S8's own inline text ("Above maximum jitter
   * (12000 ms).") is short, not the full summary sentence repeated under
   * the field it's already sitting beside. */
  inline: Record<string, string>;
}

// B3 fix (QA settings-overhaul): the copy is ux-notes §11's own named case,
// verbatim for the jitter pair ("Minimum jitter (15000 ms) is above
// maximum jitter (12000 ms). The run would fail to start.") — it names
// BOTH fields, their values, and the CONSEQUENCE, because the consequence
// is what happens at 07:00 while the user is asleep.
export function validatePacingPairs(state: FetchingState): PacingPairErrors {
  const summary: Record<string, string> = {};
  const inline: Record<string, string> = {};
  for (const pair of RAW_PACING_PAIRS) {
    const minValue = state[pair.minKey];
    const maxValue = state[pair.maxKey];
    if (minValue > maxValue) {
      const minKey = `fetching.${pair.minKey}`;
      const maxKey = `fetching.${pair.maxKey}`;
      summary[minKey] =
        `${pair.minLabel} (${minValue} ms) is above ${pair.maxLabel} (${maxValue} ms). ` +
        'The run would fail to start.';
      summary[maxKey] =
        `${capitalizeFirst(pair.maxLabel)} (${maxValue} ms) is below ` +
        `${lowercaseFirst(pair.minLabel)} (${minValue} ms). The run would fail to start.`;
      inline[minKey] = `Above ${pair.maxLabel} (${maxValue} ms).`;
      inline[maxKey] = `Below ${lowercaseFirst(pair.minLabel)} (${minValue} ms).`;
    }
  }
  return { summary, inline };
}
