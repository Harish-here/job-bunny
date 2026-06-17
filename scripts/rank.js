// scripts/rank.js — deterministic 100-pt scorer. NO LLM, NO network.
// Merges excitement_level + match_reasons[] into each job. Skill-synonym normalization is
// done upstream in the structuring step; here key_skills are matched as-is (case-insensitive).
//
// new_jobs.json (+ resume_meta.json) → new_jobs.json (in place, fields added).
//
// Scoring (100 pts):
//   Seniority match    30  Staff/Lead = full, else 0 (no partial tier)
//   Skills overlap     30  (|key_skills ∩ core_skills| / |key_skills|) * 30   [core only, Gate 5]
//   Work type + tz     20  Remote APAC = full · Remote EMEA/unknown = partial ·
//                          Chennai hybrid/on-site = full · else 0  (tz is a soft-signal, never a drop)
//   YoE fit            20  at/above = full · within -2 = partial · below 0
// Bands: >=85 Vera level · 65-84 Kandipa podu · 45-64 Try panalam · 25-44 Okay tha · <25 Deal la vidu

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeName } from "./util.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JOBS = join(ROOT, "new_jobs.json");
const META = join(ROOT, "resume_meta.json");

const WORKTYPE_PARTIAL = 10;
const YOE_PARTIAL = 10;

const normSkill = (s) => String(s).toLowerCase().trim();

function excitementFor(score) {
  if (score >= 85) return "Vera level";
  if (score >= 65) return "Kandipa podu";
  if (score >= 45) return "Try panalam";
  if (score >= 25) return "Okay tha";
  return "Deal la vidu";
}

// Pure scorer — exported for unit-style verification.
export function scoreJob(job, meta) {
  const reasons = [];

  // 1. Seniority (30) — Staff/Lead full, else zero.
  const targets = new Set((meta.target_seniority || []).map((s) => s.toLowerCase()));
  let seniority = 0;
  if (job.seniority_level && targets.has(String(job.seniority_level).toLowerCase())) {
    seniority = 30;
    reasons.push(`${job.seniority_level} matches target seniority (+30)`);
  } else {
    reasons.push(`${job.seniority_level || "Unknown"} below target seniority (+0)`);
  }

  // 2. Skills overlap (30) — core only, denominator = total JD skills.
  const core = new Set((meta.core_skills || []).map(normSkill));
  const jd = job.key_skills || [];
  let skills = 0;
  if (jd.length > 0) {
    const matched = jd.filter((k) => core.has(normSkill(k)));
    skills = Math.round((matched.length / jd.length) * 30);
    reasons.push(
      `${matched.length}/${jd.length} skills match` +
        (matched.length ? `: ${matched.join(", ")}` : "") +
        ` (+${skills})`
    );
  } else {
    reasons.push(`No JD skills listed (+0)`);
  }

  // 3. Work type + timezone (20) — tz is a soft-signal here, never a drop.
  let wt = 0;
  let wtReason;
  const inChennai = normalizeName(job.location_city) === "chennai";
  if (job.work_type === "Remote") {
    if (job.timezone_compatibility === "APAC") {
      wt = 20;
      wtReason = "Remote APAC timezone compatible (+20)";
    } else if (job.timezone_compatibility === "EMEA") {
      wt = WORKTYPE_PARTIAL;
      wtReason = `Remote EMEA timezone partial (+${WORKTYPE_PARTIAL})`;
    } else {
      wt = WORKTYPE_PARTIAL;
      wtReason = `Remote, timezone unknown (+${WORKTYPE_PARTIAL})`;
    }
  } else if ((job.work_type === "Hybrid" || job.work_type === "On-site") && inChennai) {
    wt = 20;
    wtReason = `${job.work_type} in Chennai (+20)`;
  } else {
    wt = 0;
    wtReason = `${job.work_type || "Unknown"} location fit (+0)`;
  }
  reasons.push(wtReason);

  // 4. YoE fit (20) — at/above full, within -2 partial, below zero. null requirement = full.
  let yoe = 0;
  const required = job.years_of_experience;
  const candidate = meta.current_yoe ?? 0;
  if (required == null) {
    yoe = 20;
    reasons.push("No YoE requirement (+20)");
  } else if (candidate >= required) {
    yoe = 20;
    reasons.push(`YoE ${candidate} meets ${required}${job.yoe_is_minimum ? "+" : ""} (+20)`);
  } else if (candidate >= required - 2) {
    yoe = YOE_PARTIAL;
    reasons.push(`YoE ${candidate} within 2 of ${required} (+${YOE_PARTIAL})`);
  } else {
    yoe = 0;
    reasons.push(`YoE ${candidate} below ${required} (+0)`);
  }

  const score = seniority + skills + wt + yoe;
  return { score, excitement_level: excitementFor(score), match_reasons: reasons };
}

async function main() {
  let jobs, meta;
  try {
    jobs = JSON.parse(await readFile(JOBS, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse ${JOBS}: ${err.message}`);
  }
  try {
    meta = JSON.parse(await readFile(META, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse ${META} (run generate_meta.js first): ${err.message}`);
  }
  if (!Array.isArray(jobs)) throw new Error(`${JOBS} must be a JSON array`);

  const ranked = jobs.map((job) => {
    const { score, excitement_level, match_reasons } = scoreJob(job, meta);
    return { ...job, score, excitement_level, match_reasons };
  });

  await writeFile(JOBS, JSON.stringify(ranked, null, 2) + "\n");
  for (const j of ranked) console.log(`[rank] ${j.score}  ${j.excitement_level}  — ${j.job_title} @ ${j.company_name}`);
  console.log(`[rank] scored ${ranked.length} job(s) → new_jobs.json`);
}

// Run directly → /rank
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[rank] FAILED: ${err.message}`);
    process.exit(1);
  });
}
