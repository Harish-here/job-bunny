// scripts/filter.js — Stage B filter. HARD DROPS ONLY.
//
// Location/work-type checks:
//   1. On-site AND location_city != the profile's home city (resume_meta.json `location`)
//   2. Remote AND the JD explicitly states incompatible hours
//      (structurer sets `timezone_incompatible: true`)
// Absence of timezone info NEVER drops — that is a ranking soft-signal only (rank.js).
//
// Title gate — delegated to title_filter.js (config-driven via filter_config.json).
// Tune filter_config.json title_filter section to add/remove keywords without touching this file.
//
// (Stage A title + avoid-list drops run earlier, in extract.js on card data.)
//
// jobs_raw.json + filter_config.json + resume_meta.json → filtered_jobs.json.

import { readFile, writeFile } from "node:fs/promises";
import { normalizeName } from "./util.js";
import { filterByTitle } from "./title_filter.js";
import { paths, resolveProfileName } from "./config.js";

const IN = paths().jobsRaw;
const OUT = paths().filteredJobs;
const META = paths().resumeMeta;

// Returns a drop-reason string, or null to keep. homeLocation is meta.location verbatim.
export function dropReason(job, homeLocation) {
  // --- Location / work-type checks ---
  const workType = job.work_type;
  if (workType === "On-site" && normalizeName(job.location_city) !== normalizeName(homeLocation)) {
    return `on-site outside ${homeLocation} (${job.location_city})`;
  }
  if (workType === "Remote" && job.timezone_incompatible === true) {
    return "remote with explicit incompatible hours";
  }

  // --- Title gate ---
  const result = filterByTitle(job.job_title || "");
  if (!result.pass) return result.reason;

  return null;
}

async function main() {
  console.log(`[filter] profile=${resolveProfileName()}`);
  let jobs;
  try {
    jobs = JSON.parse(await readFile(IN, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse ${IN}: ${err.message}`);
  }
  if (!Array.isArray(jobs)) throw new Error(`${IN} must be a JSON array`);

  let meta;
  try {
    meta = JSON.parse(await readFile(META, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse ${META} (run generate_meta.js first): ${err.message}`);
  }
  if (!meta.location) throw new Error(`${META} has no "location" — required for the on-site home-city check.`);

  const kept = [];
  let dropped = 0;
  for (const job of jobs) {
    const reason = dropReason(job, meta.location);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[filter] FAILED: ${err.message}`);
    process.exit(1);
  });
}
