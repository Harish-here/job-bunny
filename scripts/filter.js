// scripts/filter.js — Stage B filter. HARD DROPS ONLY.
//
// Location/work-type checks:
//   1. On-site AND location_city != Chennai
//   2. Remote AND the JD explicitly states incompatible hours
//      (structurer sets `timezone_incompatible: true`)
// Absence of timezone info NEVER drops — that is a ranking soft-signal only (rank.js).
//
// Title gate (config-driven via filter_config.json — short-circuit, top to bottom):
//   1. Seniority gate  — no seniority_keywords token in title → DROP
//   2. Title check     — any title_keywords token in title → PASS
//   3. Skills fallback — key_skills ∩ core_skills >= skills_overlap_threshold → PASS
//   4. Default         → DROP
//
// All title keyword checks use \b word-boundary matching.
// Tune filter_config.json to add/remove keywords without touching this file.
//
// (Stage A avoid-list drop runs earlier, in extract.js on card data.)
//
// jobs_raw.json + resume_meta.json + filter_config.json → filtered_jobs.json.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeName } from "./util.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IN = join(ROOT, "jobs_raw.json");
const META = join(ROOT, "resume_meta.json");
const CFG = join(ROOT, "filter_config.json");
const OUT = join(ROOT, "filtered_jobs.json");

const normSkill = (s) => String(s).toLowerCase().trim();
const wordRe = (kw) => new RegExp(`\\b${kw}\\b`);

// Returns a drop-reason string, or null to keep.
export function dropReason(job, coreSkills, cfg) {
  // --- Location / work-type checks ---
  const workType = job.work_type;
  if (workType === "On-site" && normalizeName(job.location_city) !== "chennai") {
    return `on-site outside Chennai (${job.location_city})`;
  }
  if (workType === "Remote" && job.timezone_incompatible === true) {
    return "remote with explicit incompatible hours";
  }

  // --- Title gate ---
  const title = (job.job_title || "").toLowerCase();
  const { seniorityRes, titleRes, skills_overlap_threshold: threshold } = cfg;

  // 1. Seniority gate
  if (!seniorityRes.some((re) => re.test(title))) {
    return `title missing seniority keyword (${job.job_title})`;
  }

  // 2. Title check
  if (titleRes.some((re) => re.test(title))) return null;

  // 3. Skills fallback — key_skills ∩ core_skills >= threshold
  const coreSet = new Set((coreSkills || []).map(normSkill));
  const overlap = (job.key_skills || []).filter((s) => coreSet.has(normSkill(s))).length;
  if (overlap >= threshold) return null;

  // 4. Default drop
  return `non-frontend title, ${overlap}/${threshold} core skills matched (${job.job_title})`;
}

async function main() {
  let jobs, meta, rawCfg;
  try {
    jobs = JSON.parse(await readFile(IN, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse ${IN}: ${err.message}`);
  }
  try {
    meta = JSON.parse(await readFile(META, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse ${META} (run generate_meta.js first): ${err.message}`);
  }
  try {
    rawCfg = JSON.parse(await readFile(CFG, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse ${CFG}: ${err.message}`);
  }
  if (!Array.isArray(jobs)) throw new Error(`${IN} must be a JSON array`);

  // Pre-compile regexes once
  const cfg = {
    seniorityRes: (rawCfg.seniority_keywords || []).map(wordRe),
    titleRes: (rawCfg.title_keywords || []).map(wordRe),
    skills_overlap_threshold: rawCfg.skills_overlap_threshold ?? 3,
  };

  const coreSkills = meta.core_skills || [];
  const kept = [];
  let dropped = 0;
  for (const job of jobs) {
    const reason = dropReason(job, coreSkills, cfg);
    if (reason) {
      dropped++;
      console.log(`[filter] drop "${job.job_title}" @ ${job.company_name} — ${reason}`);
    } else {
      kept.push(job);
    }
  }

  await writeFile(OUT, JSON.stringify(kept, null, 2) + "\n");
  console.log(`[filter] ${jobs.length} in → ${kept.length} kept, ${dropped} dropped → filtered_jobs.json`);
}

main().catch((err) => {
  console.error(`[filter] FAILED: ${err.message}`);
  process.exit(1);
});
