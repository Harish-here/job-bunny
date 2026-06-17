// scripts/dedup.js — drop jobs already in the (reconciled) cache, and collapse intra-batch
// duplicates. Key: job_id primary; fallback to normalized role + company when job_id absent.
// Cache is the perf mirror of Notion, rebuilt at run start by /reconcile.
//
// filtered_jobs.json → new_jobs.json.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dedupKey } from "./util.js";
import { readCache } from "./cache.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IN = join(ROOT, "filtered_jobs.json");
const OUT = join(ROOT, "new_jobs.json");

async function main() {
  let jobs;
  try {
    jobs = JSON.parse(await readFile(IN, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse ${IN}: ${err.message}`);
  }
  if (!Array.isArray(jobs)) throw new Error(`${IN} must be a JSON array`);

  const cache = await readCache();
  const seen = new Set(cache.jobs.map(dedupKey));

  const out = [];
  let dupCache = 0;
  let dupBatch = 0;
  for (const job of jobs) {
    const key = dedupKey(job);
    if (seen.has(key)) {
      // already in cache OR earlier in this batch
      if (cache.jobs.some((c) => dedupKey(c) === key)) dupCache++;
      else dupBatch++;
      console.log(`[dedup] drop "${job.job_title}" @ ${job.company_name} — duplicate (${key})`);
      continue;
    }
    seen.add(key);
    out.push(job);
  }

  await writeFile(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `[dedup] ${jobs.length} in → ${out.length} new (${dupCache} in cache, ${dupBatch} intra-batch) → new_jobs.json`
  );
}

main().catch((err) => {
  console.error(`[dedup] FAILED: ${err.message}`);
  process.exit(1);
});
