import type { StructuredJD, Verdict } from '../jd/index.ts';
import { normalizeToken } from '../jd/index.ts';
import type { RankConfig } from './rank.ts';

/**
 * core/rank/axes.ts — the five v0-parity scoring axes (skills, title,
 * seniority, work-type+location, YoE) plus the v2-only soft-verdict
 * penalty, split out of `rank.ts` (task 5, 2026-07-28 file-size split
 * plan). Pure, ZERO I/O, same input ⇒ same output — see `rank.ts`'s own
 * module doc for the full v0-parity rationale each axis carries.
 */

export const clamp = (n: number, min: number, max: number): number =>
  Math.min(Math.max(n, min), max);

/** Skills overlap axis — v0 rank.js:56-81, ported byte-exact. A single
 * shared clamped-denominator pool (NOT two independent capped pools):
 * weight = primaryMatched·primaryPoints + secondaryMatched·secondaryPoints,
 * denom = clamp(|jd skills|, denomMin, denomMax),
 * score = round(min(1, weight/denom) · maxPoints).
 * A skill matching both lists counts as primary only (v0 rank.js:63-64:
 * "core wins when listed in both"). */
export function computeSkills(
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
export function computeTitle(
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
export function computeSeniority(
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
export function computeLocation(
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
 * cfg.yoe's doc comment on `RankConfigSchema` and `rank.ts`'s module
 * comment), so this always takes v0's own null-requirement branch — a
 * fixed neutral credit, never the configured max. Kept as a real function
 * (not inlined) so the axis stays visible and testable, matching the shape
 * of every other axis here. */
export function computeYoe(cfg: RankConfig['yoe']): { points: number; reason: string } {
  return {
    points: cfg.neutralPoints,
    reason: `No YoE data modeled, neutral (+${cfg.neutralPoints})`,
  };
}

/** Soft-fail verdicts already attached to the job (set upstream by the
 * filter stage — hard fails are dropped there, soft fails are kept) cost
 * `softVerdictPenalty` points each; each one's `detail` is surfaced in
 * `matchReasons` (spec §6 payoff — no v0 counterpart). */
export function softFailPenalty(
  verdicts: readonly Verdict[],
  penaltyPerRule: number,
): { penalty: number; reasons: string[] } {
  const softFails = verdicts.filter((v) => v.severity === 'soft' && !v.pass);
  return {
    penalty: softFails.length * penaltyPerRule,
    reasons: softFails.map((v) => v.detail ?? `${v.rule}: soft-fail`),
  };
}
