// scripts/filter.js — Stage B filter. HARD DROPS ONLY:
//   1. On-site AND location_city != Chennai
//   2. Remote AND the JD explicitly states incompatible hours
//      (structurer sets `timezone_incompatible: true` — Phase 5 contract).
// Absence of timezone info NEVER drops — that is a ranking soft-signal only (rank.js).
// (Stage A avoid-list drop runs earlier, in extract.js on card data.)
//
// jobs_raw.json → filtered_jobs.json.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeName } from "./util.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IN = join(ROOT, "jobs_raw.json");
const OUT = join(ROOT, "filtered_jobs.json");

// Returns a drop-reason string, or null to keep.
export function dropReason(job) {
  const workType = job.work_type;
  if (workType === "On-site" && normalizeName(job.location_city) !== "chennai") {
    return `on-site outside Chennai (${job.location_city})`;
  }
  if (workType === "Remote" && job.timezone_incompatible === true) {
    return "remote with explicit incompatible hours";
  }
  return null;
}

async function main() {
  let jobs;
  try {
    jobs = JSON.parse(await readFile(IN, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse ${IN}: ${err.message}`);
  }
  if (!Array.isArray(jobs)) throw new Error(`${IN} must be a JSON array`);

  const kept = [];
  let dropped = 0;
  for (const job of jobs) {
    const reason = dropReason(job);
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
