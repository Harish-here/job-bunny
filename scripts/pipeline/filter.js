// scripts/pipeline/filter.js — Stage B filter. HARD DROPS ONLY.
//
// Thin adapter: maps a structured job record into the jd_filter.js canonical JD model and
// runs it through the shared engine (evaluate() + loadFilterContext()). All rule logic —
// avoid-list, title gate, on-site/hybrid location, remote-country, remote-timezone, core-skill —
// lives in jd_filter.js; this file owns only the field mapping and the pipeline I/O contract.
//
// (Stage A title + avoid-list drops also run earlier, in extract.js on card data — this is a
// second, JD-informed pass since more fields are known post-structuring.)
//
// jobs_raw.json + filter_config.json + resume_meta.json (via loadFilterContext) → filtered_jobs.json.

import { isMain } from "../lib/cli.js";
import { readJson, writeJson } from "../lib/io.js";
import { paths, resolveProfileName } from "../lib/config.js";
import { loadFilterContext, evaluate } from "./jd_filter.js";

const IN = paths().jobsRaw;
const OUT = paths().filteredJobs;

// Structured job record (assemble.js output) → jd_filter.js canonical JD model.
export function toCanonicalJd(job) {
  return {
    title: job.job_title,
    company: job.company_name,
    skills: job.key_skills,
    work_type: job.work_type,
    city: job.location_city,
    country: job.country,
    timezone: job.timezone_compatibility,
    tz_bad: job.timezone_incompatible,
  };
}

async function main() {
  console.log(`[filter] profile=${resolveProfileName()}`);
  const jobs = await readJson(IN);
  if (!Array.isArray(jobs)) throw new Error(`${IN} must be a JSON array`);

  const ctx = await loadFilterContext();

  const kept = [];
  let dropped = 0;
  for (const job of jobs) {
    const jd = toCanonicalJd(job);
    const result = evaluate(jd, ctx, { severity: "normal" });
    if (result.drop) {
      dropped++;
      console.log(`[filter] drop "${job.job_title}" @ ${job.company_name} — ${result.reasons.join(", ")}`);
    } else {
      job.filter_flags = result.flags;
      kept.push(job);
    }
  }

  await writeJson(OUT, kept);
  console.log(`[filter] ${jobs.length} in → ${kept.length} kept, ${dropped} dropped → filtered_jobs.json`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[filter] FAILED: ${err.message}`);
    process.exit(1);
  });
}
