import { z } from 'zod';
import type { EvaluatedJD, StructuredJD, Verdict } from '../jd/index.ts';
import { normalizeToken } from '../jd/index.ts';

/**
 * Deterministic scorer (spec §6), ported from v0 scripts/pipeline/rank.js —
 * pure, ZERO I/O, no Date.now()/Math.random(). Same input ⇒ same output.
 *
 * v0 scores 5 axes out of 100: skills 40 (rank.js:56-81), title 15
 * (rank.js:83-99), seniority 15 (rank.js:101-109), work-type+tz 20
 * (rank.js:111-147), YoE 10 (rank.js:149-166). All five are restored here:
 *
 *   - skills, work-type+tz: v0's data (JD skill list, work type, timezone,
 *     home-city membership) maps directly onto StructuredJD.structured —
 *     ported byte-exact, as before.
 *   - title: v0 matches profile domain keywords as a substring of the raw
 *     job title. StructuredJD.identity.title carries that same raw title
 *     (always present, unlike structured.titleParts.domain, which is an
 *     LLM-extracted single value, not a keyword-match target) — ported
 *     byte-exact against `identity.title`.
 *   - seniority: v0 compares job.seniority_level against a configured
 *     target list. StructuredJD.structured.titleParts.seniority is the same
 *     signal (confirmed by adapters/db/notion/schema.ts's SENIORITY_OPTIONS,
 *     which pins seniority as a real per-JD field synced to Notion) — ported
 *     byte-exact against `titleParts.seniority`.
 *   - YoE: genuinely has no counterpart. v0 needs BOTH a JD-side requirement
 *     (job.years_of_experience / job.yoe_is_minimum) and a candidate-side
 *     current YoE (meta.current_yoe); StructuredSchema has neither field,
 *     and no candidate-YoE input exists on RankConfig either. Per the task's
 *     never-silently-drop rule, the axis's config (and its point budget) is
 *     kept in RankConfigSchema, but scoreJob always takes v0's own
 *     null-requirement branch (rank.js:154-156): a fixed neutral-partial
 *     credit, never the axis max. This is the one axis whose ceiling is
 *     structurally unreachable today — see cfg.yoe's doc comment and the
 *     module's CEILING note in the task write-up.
 *
 * The one genuinely new behavior vs v0 (spec §6 payoff): every soft-fail
 * verdict already attached to the job (severity 'soft', pass false — set
 * upstream by the filter stage, which keeps soft failures rather than
 * dropping them) costs `softVerdictPenalty` points, and its `detail` string
 * is surfaced in `matchReasons`. v0 has no equivalent.
 */

export const WorkTypePreferenceSchema = z.object({
  onsite: z.number().min(0).default(1),
  hybrid: z.number().min(0).default(1),
  remote: z.number().min(0).default(1),
});

export const RankConfigSchema = z.object({
  skills: z
    .object({
      /** Profile's must-have skills (v0 meta.core_skills). */
      primary: z.array(z.string().min(1)).default([]),
      /** Profile's nice-to-have skills (v0 meta.secondary_skills). */
      secondary: z.array(z.string().min(1)).default([]),
      /** Per-match weight for a primary-skill hit — v0 rank.js:68 core
       * coefficient (1.0), feeding the shared clamped-denominator formula
       * below (NOT an independent point pool — see `computeSkills`). */
      primarySkillPoints: z.number().min(0).default(1),
      /** Per-match weight for a secondary-skill hit — v0 rank.js:68
       * secondary coefficient (0.5). */
      secondarySkillPoints: z.number().min(0).default(0.5),
      /** Axis cap — v0 rank.js:28 SKILLS_MAX. */
      maxPoints: z.number().min(0).default(40),
      /** Denominator clamp floor/ceiling — v0 rank.js:36-37
       * SKILLS_DENOM_MIN/MAX (so a 1-skill JD can't spike and a laundry
       * list can't tank). */
      denomMin: z.number().int().min(1).default(3),
      denomMax: z.number().int().min(1).default(8),
    })
    // zod's object-level .default() is used verbatim, NOT re-parsed through
    // the inner schema (so it must spell out every per-field default itself
    // — see rank.test.ts's "empty config parses with documented defaults").
    .default({
      primary: [],
      secondary: [],
      primarySkillPoints: 1,
      secondarySkillPoints: 0.5,
      maxPoints: 40,
      denomMin: 3,
      denomMax: 8,
    }),
  title: z
    .object({
      /** Profile's domain keywords (v0 filter_config title_filter.domain),
       * matched as a substring of the JD title — empty list ⇒ neutral
       * credit (v0 rank.js:87-90's "legacy mode", so profiles without this
       * config aren't punished). */
      domainKeywords: z.array(z.string().min(1)).default([]),
      /** Full-match points — v0 rank.js:29 TITLE_MAX. */
      maxPoints: z.number().min(0).default(15),
      /** Score when no domain keywords are configured — v0 rank.js:30
       * TITLE_NEUTRAL. */
      neutralPoints: z.number().min(0).default(8),
    })
    .default({ domainKeywords: [], maxPoints: 15, neutralPoints: 8 }),
  seniority: z
    .object({
      /** Profile's target seniority levels (v0 meta.target_seniority),
       * matched case-insensitively — no partial tier, same as v0. */
      targets: z.array(z.string().min(1)).default([]),
      /** Full-match points — v0 rank.js:31 SENIORITY_MAX. */
      maxPoints: z.number().min(0).default(15),
    })
    .default({ targets: [], maxPoints: 15 }),
  location: z
    .object({
      /** Profile's home cities (v0 meta.location / isHomeCity). */
      homeCities: z.array(z.string().min(1)).default([]),
      /** Full-credit remote timezones (v0 filter_config remote.timezones.acceptable). */
      acceptableTimezones: z.array(z.string().min(1)).default([]),
      /** Partial-credit remote timezones (v0 filter_config remote.timezones.borderline). */
      borderlineTimezones: z.array(z.string().min(1)).default([]),
      /** Full-match points — v0 rank.js:32 WORKTYPE_MAX. */
      bonus: z.number().min(0).default(20),
      /** Partial-match points — v0 rank.js:33 WORKTYPE_PARTIAL. */
      partial: z.number().min(0).default(10),
    })
    .default({
      homeCities: [],
      acceptableTimezones: [],
      borderlineTimezones: [],
      bonus: 20,
      partial: 10,
    }),
  /** YoE fit axis — v0 rank.js:149-166. NOT achievable today: v2's
   * StructuredJD models neither a JD-side YoE requirement nor a
   * candidate-side current YoE (no such fields anywhere in this codebase's
   * StructuredSchema or RankConfig), so `maxPoints`/`partialPoints` below
   * are never differentiated — scoreJob always awards `neutralPoints`,
   * exactly what v0 itself gives when job.years_of_experience is null
   * (rank.js:154-156). Kept in the schema (rather than silently dropped)
   * purely for point-accounting honesty; see the module comment above and
   * this task's CEILING note for the arithmetic this implies. */
  yoe: z
    .object({
      /** Axis cap — v0 rank.js:34 YOE_MAX. Unreachable — see above. */
      maxPoints: z.number().min(0).default(10),
      /** Score always awarded — v0 rank.js:35 YOE_PARTIAL, the same value
       * v0 itself falls back to for a null YoE requirement. */
      neutralPoints: z.number().min(0).default(5),
    })
    .default({ maxPoints: 10, neutralPoints: 5 }),
  /** NEW in v2 — no v0 counterpart. Per-work-type multiplier applied to the
   * location/work-type axis score; default 1 for every type reproduces v0's
   * implicit equal treatment exactly (see the replay fixture). Lets a
   * profile deprioritize (e.g.) on-site roles without a hard filter drop. */
  workTypePreference: WorkTypePreferenceSchema.default({
    onsite: 1,
    hybrid: 1,
    remote: 1,
  }),
  /** NEW in v2 — no v0 counterpart (spec §6 payoff). Points deducted per
   * soft-fail verdict already attached to the job. */
  softVerdictPenalty: z.number().min(0).default(5),
});

export type RankConfig = z.infer<typeof RankConfigSchema>;

/** v0 rank.js:41-45 excitementFor — bands pinned exactly (same thresholds,
 * same strings). Reachable under the restored default config: the realistic
 * ceiling (see CEILING note) is 95 (yoe's axis is fixed to its neutral 5,
 * never its max 10 — see cfg.yoe's doc comment), comfortably above 85, so
 * every band — including the top one — is reachable without adjusting v0's
 * thresholds. */
function excitementFor(score: number): string {
  if (score >= 85) return 'Vera level';
  if (score >= 65) return 'Kandipa podu';
  return 'Try panalam';
}

const clamp = (n: number, min: number, max: number): number =>
  Math.min(Math.max(n, min), max);

/** Skills overlap axis — v0 rank.js:56-81, ported byte-exact. A single
 * shared clamped-denominator pool (NOT two independent capped pools):
 * weight = primaryMatched·primaryPoints + secondaryMatched·secondaryPoints,
 * denom = clamp(|jd skills|, denomMin, denomMax),
 * score = round(min(1, weight/denom) · maxPoints).
 * A skill matching both lists counts as primary only (v0 rank.js:63-64:
 * "core wins when listed in both"). */
function computeSkills(
  jdSkills: readonly string[],
  cfg: RankConfig['skills'],
): { points: number; reason: string } {
  if (jdSkills.length === 0) {
    return { points: 0, reason: 'No JD skills listed (+0)' };
  }
  const primarySet = new Set(cfg.primary.map(normalizeToken));
  const secondarySet = new Set(cfg.secondary.map(normalizeToken));
  const primaryMatched: string[] = [];
  const secondaryMatched: string[] = [];
  for (const skill of jdSkills) {
    const n = normalizeToken(skill);
    if (primarySet.has(n)) primaryMatched.push(skill);
    else if (secondarySet.has(n)) secondaryMatched.push(skill);
  }
  const weight =
    primaryMatched.length * cfg.primarySkillPoints +
    secondaryMatched.length * cfg.secondarySkillPoints;
  const denom = clamp(jdSkills.length, cfg.denomMin, cfg.denomMax);
  const points = Math.round(Math.min(1, weight / denom) * cfg.maxPoints);
  const parts: string[] = [];
  if (primaryMatched.length) parts.push(`primary: ${primaryMatched.join(', ')}`);
  if (secondaryMatched.length) parts.push(`secondary: ${secondaryMatched.join(', ')}`);
  const total = primaryMatched.length + secondaryMatched.length;
  const reason =
    `${total}/${jdSkills.length} skills match` +
    (parts.length ? ` (${parts.join('; ')})` : '') +
    ` (+${points})`;
  return { points, reason };
}

/** Title relevance axis — v0 rank.js:83-99, ported byte-exact against
 * StructuredJD.identity.title (the raw JD title — always present, unlike
 * structured.titleParts.domain, an LLM-extracted single value that isn't a
 * keyword-match target). No domain keywords configured (legacy mode) scores
 * neutral so those profiles aren't punished — same as v0. Matching is
 * token-normalized (this module's existing convention — see computeSkills/
 * computeLocation) rather than v0's plain lowercase substring check; since
 * normalizeToken strips the same separators on both sides, a multi-word
 * keyword still matches iff its words are contiguous in the title, so this
 * is a faithful port, not a behavior change. */
function computeTitle(
  title: string,
  cfg: RankConfig['title'],
): { points: number; reason: string } {
  if (cfg.domainKeywords.length === 0) {
    return {
      points: cfg.neutralPoints,
      reason: `No domain keywords configured, title neutral (+${cfg.neutralPoints})`,
    };
  }
  const folded = normalizeToken(title);
  const hit = cfg.domainKeywords.find((k) => folded.includes(normalizeToken(k)));
  if (hit) {
    return {
      points: cfg.maxPoints,
      reason: `Title matches domain "${hit}" (+${cfg.maxPoints})`,
    };
  }
  return { points: 0, reason: 'Title has no domain keyword (+0)' };
}

/** Seniority axis — v0 rank.js:101-109, ported byte-exact against
 * StructuredJD.structured.titleParts.seniority (confirmed as a real per-JD
 * field by adapters/db/notion/schema.ts's SENIORITY_OPTIONS select pin). In
 * target list ⇒ full credit; otherwise zero — no partial tier, same as v0.
 * An undefined seniority (the LLM found none) is a miss, not an error,
 * matching v0's `job.seniority_level || "Unknown"` fallback. */
function computeSeniority(
  seniority: string | undefined,
  cfg: RankConfig['seniority'],
): { points: number; reason: string } {
  const targets = new Set(cfg.targets.map(normalizeToken));
  if (seniority && targets.has(normalizeToken(seniority))) {
    return {
      points: cfg.maxPoints,
      reason: `${seniority} matches target seniority (+${cfg.maxPoints})`,
    };
  }
  return { points: 0, reason: `${seniority ?? 'Unknown'} below target seniority (+0)` };
}

/** Work-type + location axis — v0 rank.js:118-147, ported byte-exact for
 * the base (bonus/partial) points, then scaled by the NEW workTypePreference
 * multiplier (default 1 ⇒ v0-identical). Remote scores off timezone bands;
 * hybrid/on-site scores off home-city membership; an undefined `workType`
 * (a shape v0 never produced — its job.work_type was always set) is treated
 * as a neutral miss rather than an error, matching this module's
 * tolerant-on-missing-data posture (mirrors v0 rank.js:114-125's own
 * tolerance for a missing/invalid location). */
function computeLocation(
  structured: StructuredJD['structured'],
  cfg: RankConfig['location'],
  preference: RankConfig['workTypePreference'],
): { points: number; reason: string } {
  const { workType } = structured;
  if (workType === undefined) {
    return { points: 0, reason: 'Work type unknown (+0)' };
  }
  const homeCities = new Set(cfg.homeCities.map(normalizeToken));
  let base: number;
  let reason: string;
  if (workType === 'remote') {
    const acceptable = new Set(cfg.acceptableTimezones.map(normalizeToken));
    const borderline = new Set(cfg.borderlineTimezones.map(normalizeToken));
    const tz = normalizeToken(structured.timezone ?? '');
    if (tz && acceptable.has(tz)) {
      base = cfg.bonus;
      reason = `Remote ${structured.timezone} timezone acceptable (+${cfg.bonus})`;
    } else if (tz && borderline.has(tz)) {
      base = cfg.partial;
      reason = `Remote ${structured.timezone} timezone borderline (+${cfg.partial})`;
    } else {
      base = cfg.partial;
      reason = `Remote, timezone unknown (+${cfg.partial})`;
    }
  } else {
    const inHomeCity = structured.locations.some((loc) =>
      homeCities.has(normalizeToken(loc.city)),
    );
    if (inHomeCity) {
      base = cfg.bonus;
      reason = `${workType} in home city (+${cfg.bonus})`;
    } else {
      base = 0;
      reason = `${workType} location fit (+0)`;
    }
  }
  const pref = preference[workType];
  const points = Math.round(base * pref);
  return {
    points,
    reason: pref === 1 ? reason : `${reason} × ${pref} workType preference`,
  };
}

/** YoE fit axis — v0 rank.js:149-166. Genuinely not portable: v2 has
 * neither a JD-side YoE requirement nor a candidate-side current YoE (see
 * cfg.yoe's doc comment and the module comment above), so this always takes
 * v0's own null-requirement branch — a fixed neutral credit, never the
 * configured max. Kept as a real function (not inlined) so the axis stays
 * visible and testable, matching the shape of every other axis here. */
function computeYoe(cfg: RankConfig['yoe']): { points: number; reason: string } {
  return {
    points: cfg.neutralPoints,
    reason: `No YoE data modeled, neutral (+${cfg.neutralPoints})`,
  };
}

/** Soft-fail verdicts already attached to the job (set upstream by the
 * filter stage — hard fails are dropped there, soft fails are kept) cost
 * `softVerdictPenalty` points each; each one's `detail` is surfaced in
 * `matchReasons` (spec §6 payoff — no v0 counterpart). */
function softFailPenalty(
  verdicts: readonly Verdict[],
  penaltyPerRule: number,
): { penalty: number; reasons: string[] } {
  const softFails = verdicts.filter((v) => v.severity === 'soft' && !v.pass);
  return {
    penalty: softFails.length * penaltyPerRule,
    reasons: softFails.map((v) => v.detail ?? `${v.rule}: soft-fail`),
  };
}

/** Score a single StructuredJD against `cfg`. Exported for unit-level
 * axis-isolation tests; `rank()` below is the batch entry point. Axis order
 * (and therefore `matchReasons` order) mirrors v0 rank.js exactly: skills,
 * title, seniority, work-type+location, YoE, then (v2-only) soft-verdict
 * penalties. */
export function scoreJob(
  jd: StructuredJD,
  cfg: RankConfig,
): { score: number; excitement: string; matchReasons: string[] } {
  const reasons: string[] = [];
  const skills = computeSkills(jd.structured.skills, cfg.skills);
  reasons.push(skills.reason);
  const title = computeTitle(jd.identity.title, cfg.title);
  reasons.push(title.reason);
  const seniority = computeSeniority(jd.structured.titleParts.seniority, cfg.seniority);
  reasons.push(seniority.reason);
  const location = computeLocation(jd.structured, cfg.location, cfg.workTypePreference);
  reasons.push(location.reason);
  const yoe = computeYoe(cfg.yoe);
  reasons.push(yoe.reason);
  const existingVerdicts = jd.evaluation?.verdicts ?? [];
  const { penalty, reasons: penaltyReasons } = softFailPenalty(
    existingVerdicts,
    cfg.softVerdictPenalty,
  );
  reasons.push(...penaltyReasons);

  const score = clamp(
    skills.points +
      title.points +
      seniority.points +
      location.points +
      yoe.points -
      penalty,
    0,
    100,
  );
  return { score, excitement: excitementFor(score), matchReasons: reasons };
}

/** Batch entry point (Task 2 contract): scores every job, returns new
 * objects — input `jobs` is never mutated. Existing `evaluation.verdicts` /
 * `duplicateOf` (set by the filter/dedup stages upstream) are carried
 * through unchanged; only `score`, `excitement`, and `matchReasons` are
 * (re)computed here. */
export function rank(jobs: readonly StructuredJD[], cfg: RankConfig): EvaluatedJD[] {
  return jobs.map((jd) => {
    const { score, excitement, matchReasons } = scoreJob(jd, cfg);
    const priorMatchReasons = jd.evaluation?.matchReasons ?? [];
    return {
      ...jd,
      evaluation: {
        verdicts: jd.evaluation?.verdicts ?? [],
        duplicateOf: jd.evaluation?.duplicateOf,
        score,
        excitement,
        matchReasons: [...priorMatchReasons, ...matchReasons],
      },
    };
  });
}
