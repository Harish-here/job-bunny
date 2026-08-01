import { z } from 'zod';
import type { EvaluatedJD, StructuredJD } from '../jd/index.ts';
import { EXCITEMENT_OPTIONS } from '../tracking/index.ts';
import {
  clamp,
  computeLocation,
  computeSeniority,
  computeSkills,
  computeTitle,
  computeYoe,
  softFailPenalty,
} from './axes.ts';

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
 *
 * The five axis functions themselves (`clamp`, `computeSkills`,
 * `computeTitle`, `computeSeniority`, `computeLocation`, `computeYoe`,
 * `softFailPenalty`) live in `./axes.ts` (split out, task 5 of the
 * 2026-07-28 file-size split plan) — this file keeps the config schemas,
 * `excitementFor`, `scoreJob`, and the batch entry point `rank`.
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
  const [top, mid, low] = EXCITEMENT_OPTIONS;
  if (score >= 85) return top;
  if (score >= 65) return mid;
  return low;
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
    return {
      ...jd,
      evaluation: {
        verdicts: jd.evaluation?.verdicts ?? [],
        duplicateOf: jd.evaluation?.duplicateOf,
        score,
        excitement,
        matchReasons,
      },
    };
  });
}
