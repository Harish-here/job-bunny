// scripts/pipeline/rank.js — deterministic 100-pt scorer. NO LLM, NO network.
// Merges excitement_level + match_reasons[] into each job. Skill-synonym normalization is
// done upstream in the structuring step; here key_skills are matched as-is (case-insensitive).
// Jobs with zero matched core (primary) skills — including jobs with no key_skills at all —
// are DROPPED from the output entirely, not merely down-scored.
//
// new_jobs.json (+ resume_meta.json, filter_config.json) → new_jobs.json (in place, zero-core-
// match jobs removed, surviving jobs get fields added).
//
// Scoring (100 pts) — relevance 70, logistics 30:
//   Skills overlap     40  weighted matches (core ×1.0, secondary ×0.5) ÷ clamp(|jd|, 3, 8), max 1.0
//   Title relevance    15  job_title contains a filter_config title_filter.domain keyword = full ·
//                          no keywords configured (legacy) = neutral 8 · miss = 0
//   Seniority match    15  in target_seniority = full, else 0 (no partial tier)
//   Work type + tz     20  Remote APAC = full · Remote EMEA/unknown = partial ·
//                          home-city (meta.location) hybrid/on-site = full · else 0
//                          (tz is a soft-signal, never a drop)
//   YoE fit            10  at/above = full · within -2 = partial · below 0 · null = neutral partial
// Hard drop: 0 core-skill matches (including empty/missing key_skills) → job is removed from
// the output entirely in main(), not merely down-scored.
// Bands: >=85 Vera level · 65-84 Kandipa podu · <65 Try panalam

import { readFile } from "node:fs/promises";
import { isMain } from "../lib/cli.js";
import { readJson, writeJson } from "../lib/io.js";
import { homeLocations, isHomeCity } from "../lib/util.js";
import { paths, resolveProfileName } from "../lib/config.js";

const SKILLS_MAX = 40;
const TITLE_MAX = 15;
const TITLE_NEUTRAL = 8;
const SENIORITY_MAX = 15;
const WORKTYPE_MAX = 20;
const WORKTYPE_PARTIAL = 10;
const YOE_MAX = 10;
const YOE_PARTIAL = 5;
const SKILLS_DENOM_MIN = 3;
const SKILLS_DENOM_MAX = 8;

const normSkill = (s) => String(s).toLowerCase().trim();

function excitementFor(score) {
  if (score >= 85) return "Vera level";
  if (score >= 65) return "Kandipa podu";
  return "Try panalam";
}

// Pure scorer — exported for unit-style verification. opts.domainKeywords: the profile's
// filter_config title_filter.domain list; undefined/empty → neutral title credit.
export function scoreJob(job, meta, opts = {}) {
  const reasons = [];

  // 1. Skills overlap (40) — core ×1.0, secondary ×0.5 (core wins when listed in both);
  //    denominator clamped so 1-skill JDs can't spike and laundry lists can't tank.
  const core = new Set((meta.core_skills || []).map(normSkill));
  const secondary = new Set((meta.secondary_skills || []).map(normSkill));
  const jd = job.key_skills || [];
  const coreMatched = [];
  const secondaryMatched = [];
  for (const k of jd) {
    const n = normSkill(k);
    if (core.has(n)) coreMatched.push(k);
    else if (secondary.has(n)) secondaryMatched.push(k);
  }
  let skills = 0;
  if (jd.length > 0) {
    const weight = coreMatched.length + secondaryMatched.length * 0.5;
    const denom = Math.min(Math.max(jd.length, SKILLS_DENOM_MIN), SKILLS_DENOM_MAX);
    skills = Math.round(Math.min(1, weight / denom) * SKILLS_MAX);
    const parts = [];
    if (coreMatched.length) parts.push(`core: ${coreMatched.join(", ")}`);
    if (secondaryMatched.length) parts.push(`secondary: ${secondaryMatched.join(", ")}`);
    reasons.push(
      `${coreMatched.length + secondaryMatched.length}/${jd.length} skills match` +
        (parts.length ? ` (${parts.join("; ")})` : "") +
        ` (+${skills})`
    );
  } else {
    reasons.push(`No JD skills listed (+0)`);
  }

  // 2. Title relevance (15) — profile domain keywords vs job_title; no keywords configured
  //    (legacy mode) scores neutral so those profiles aren't punished.
  const keywords = (opts.domainKeywords || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean);
  const title = String(job.job_title || "").toLowerCase();
  let titlePts = 0;
  if (keywords.length === 0) {
    titlePts = TITLE_NEUTRAL;
    reasons.push(`No domain keywords configured, title neutral (+${TITLE_NEUTRAL})`);
  } else {
    const hit = keywords.find((k) => title.includes(k));
    if (hit) {
      titlePts = TITLE_MAX;
      reasons.push(`Title matches domain "${hit}" (+${TITLE_MAX})`);
    } else {
      reasons.push(`Title has no domain keyword (+0)`);
    }
  }

  // 3. Seniority (15) — in target list full, else zero.
  const targets = new Set((meta.target_seniority || []).map((s) => s.toLowerCase()));
  let seniority = 0;
  if (job.seniority_level && targets.has(String(job.seniority_level).toLowerCase())) {
    seniority = SENIORITY_MAX;
    reasons.push(`${job.seniority_level} matches target seniority (+${SENIORITY_MAX})`);
  } else {
    reasons.push(`${job.seniority_level || "Unknown"} below target seniority (+0)`);
  }

  // 4. Work type + timezone (20) — tz is a soft-signal here, never a drop. A missing/invalid
  // meta.location degrades to "not home city" here (never throws) — main() validates the
  // shape up front for the real pipeline run; scoreJob() itself stays tolerant so axis-
  // isolation callers can omit location entirely when it's irrelevant to what they're testing.
  let wt = 0;
  let wtReason;
  let inHomeCity = false;
  try {
    inHomeCity = isHomeCity(job.location_city, meta.location);
  } catch {
    // invalid/missing location — treated as "no home city match", not an error, here.
  }
  if (job.work_type === "Remote") {
    if (job.timezone_compatibility === "APAC") {
      wt = WORKTYPE_MAX;
      wtReason = `Remote APAC timezone compatible (+${WORKTYPE_MAX})`;
    } else if (job.timezone_compatibility === "EMEA") {
      wt = WORKTYPE_PARTIAL;
      wtReason = `Remote EMEA timezone partial (+${WORKTYPE_PARTIAL})`;
    } else {
      wt = WORKTYPE_PARTIAL;
      wtReason = `Remote, timezone unknown (+${WORKTYPE_PARTIAL})`;
    }
  } else if ((job.work_type === "Hybrid" || job.work_type === "On-site") && inHomeCity) {
    wt = WORKTYPE_MAX;
    wtReason = `${job.work_type} in ${homeLocations(meta.location).join("/")} (+${WORKTYPE_MAX})`;
  } else {
    wt = 0;
    wtReason = `${job.work_type || "Unknown"} location fit (+0)`;
  }
  reasons.push(wtReason);

  // 5. YoE fit (10) — at/above full, within -2 partial, below zero. null requirement is a
  //    missing signal, not a green light → neutral partial.
  let yoe = 0;
  const required = job.years_of_experience;
  const candidate = meta.current_yoe ?? 0;
  if (required == null) {
    yoe = YOE_PARTIAL;
    reasons.push(`No YoE requirement, neutral (+${YOE_PARTIAL})`);
  } else if (candidate >= required) {
    yoe = YOE_MAX;
    reasons.push(`YoE ${candidate} meets ${required}${job.yoe_is_minimum ? "+" : ""} (+${YOE_MAX})`);
  } else if (candidate >= required - 2) {
    yoe = YOE_PARTIAL;
    reasons.push(`YoE ${candidate} within 2 of ${required} (+${YOE_PARTIAL})`);
  } else {
    yoe = 0;
    reasons.push(`YoE ${candidate} below ${required} (+0)`);
  }

  const score = skills + titlePts + seniority + wt + yoe;

  // No core-skill match means the role isn't ours no matter how convenient the logistics are
  // (the architect-title over-credit fix) — flagged here, dropped by main() before the write.
  const dropped = coreMatched.length === 0;
  if (dropped) reasons.push(`No core skill match — dropped (score was ${score})`);

  return { score, excitement_level: excitementFor(score), match_reasons: reasons, dropped };
}

// Best-effort load of the profile's domain keywords — a missing/unparsable filter_config
// (legacy mode) must degrade to neutral title scoring, never fail the stage.
async function loadDomainKeywords() {
  try {
    const cfg = JSON.parse(await readFile(paths().filterConfig, "utf8"));
    return cfg?.title_filter?.domain || [];
  } catch {
    return [];
  }
}

async function main() {
  console.log(`[rank] profile=${resolveProfileName()}`);
  const { newJobs: JOBS, resumeMeta: META } = paths();
  const jobs = await readJson(JOBS);
  const meta = await readJson(META, "run generate_meta.js first");
  if (!Array.isArray(jobs)) throw new Error(`${JOBS} must be a JSON array`);
  try {
    homeLocations(meta.location);
  } catch (err) {
    throw new Error(`${META} "location" is invalid — required for the work-type/home-city axis: ${err.message}`);
  }

  const domainKeywords = await loadDomainKeywords();
  if (domainKeywords.length === 0) console.log(`[rank] no domain keywords — title axis neutral`);

  const scored = jobs.map((job) => {
    const { score, excitement_level, match_reasons, dropped } = scoreJob(job, meta, { domainKeywords });
    return { ...job, score, excitement_level, match_reasons, dropped };
  });

  const ranked = scored
    .filter((j) => !j.dropped)
    .map(({ dropped, ...rest }) => rest);
  const droppedCount = scored.length - ranked.length;

  await writeJson(JOBS, ranked);
  for (const j of ranked) console.log(`[rank] ${j.score}  ${j.excitement_level}  — ${j.job_title} @ ${j.company_name}`);
  console.log(`[rank] Dropped ${droppedCount}/${scored.length} jobs with no core skill match → ${ranked.length} kept → new_jobs.json`);
}

// Run directly → /rank
if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[rank] FAILED: ${err.message}`);
    process.exit(1);
  });
}
