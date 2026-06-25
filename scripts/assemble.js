// scripts/assemble.js — merges LLM decisions with passthrough fields → jobs_raw.json.
// Reads jobs_raw_decisions.json + structure_passthrough.json, merges on job_id.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IN_DECISIONS = join(ROOT, "jobs_raw_decisions.json");
const IN_PASSTHROUGH = join(ROOT, "structure_passthrough.json");
const OUT = join(ROOT, "jobs_raw.json");

const REQUIRED_FIELDS = [
  "job_id", "job_title", "company_name", "seniority_level",
  "location_city", "work_type", "key_skills", "job_url", "date_found",
];

async function main() {
  let rawDecisions, rawPassthrough;
  try {
    [rawDecisions, rawPassthrough] = await Promise.all([
      readFile(IN_DECISIONS, "utf8"),
      readFile(IN_PASSTHROUGH, "utf8"),
    ]);
  } catch (err) {
    throw new Error(`Cannot read input files: ${err.message}`);
  }
  let decisions, passthrough;
  try { decisions = JSON.parse(rawDecisions); } catch (err) {
    throw new Error(`Cannot parse ${IN_DECISIONS}: ${err.message}`);
  }
  try { passthrough = JSON.parse(rawPassthrough); } catch (err) {
    throw new Error(`Cannot parse ${IN_PASSTHROUGH}: ${err.message}`);
  }
  if (!Array.isArray(decisions)) throw new Error(`${IN_DECISIONS} must be a JSON array`);
  if (!Array.isArray(passthrough)) throw new Error(`${IN_PASSTHROUGH} must be a JSON array`);

  const ptMap = new Map(passthrough.map((p) => [p.job_id, p]));

  const merged = decisions.map((d, i) => {
    const pt = ptMap.get(d.job_id);
    if (!pt) throw new Error(`No passthrough entry for job_id "${d.job_id}" (decision index ${i})`);
    const job = { ...d, job_url: pt.job_url, date_found: pt.date_found, source_query_url: pt.source_query_url };

    const missing = REQUIRED_FIELDS.filter((f) => job[f] === undefined || job[f] === null);
    if (missing.length) {
      throw new Error(`job_id "${d.job_id}" missing required fields: ${missing.join(", ")}`);
    }
    return job;
  });

  await writeFile(OUT, JSON.stringify(merged, null, 2) + "\n");
  console.log(`[assemble] ${merged.length} jobs merged → jobs_raw.json`);
}

main().catch((err) => {
  console.error(`[assemble] FAILED: ${err.message}`);
  process.exit(1);
});
