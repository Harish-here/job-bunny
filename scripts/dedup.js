// scripts/dedup.js — drop jobs already in the (reconciled) cache, and collapse intra-batch
// duplicates. Key: job_id primary; fallback to normalized role + company when job_id absent.
// A fresh job_id whose role+company+city already exists is a LinkedIn repost — dropped too,
// nothing written to Notion (the existing row stands).
// Cache is the perf mirror of Notion, rebuilt at run start by /reconcile.
//
// filtered_jobs.json → new_jobs.json.

import { readFile, writeFile } from "node:fs/promises";
import { dedupKey, repostKey } from "./util.js";
import { readCache } from "./cache.js";
import { paths, resolveProfileName } from "./config.js";

// Pure core: dedup `jobs` against `cacheJobs` + earlier entries in the batch.
// Returns { kept, dupCache, dupBatch, reposts } — logs each drop with its reason.
export function dedupJobs(jobs, cacheJobs, log = console.log) {
  const cacheKeys = new Set(cacheJobs.map(dedupKey));
  const seen = new Set(cacheKeys);
  const seenReposts = new Set(cacheJobs.map(repostKey));

  const kept = [];
  let dupCache = 0;
  let dupBatch = 0;
  let reposts = 0;
  for (const job of jobs) {
    const key = dedupKey(job);
    if (seen.has(key)) {
      // already in cache OR earlier in this batch
      if (cacheKeys.has(key)) dupCache++;
      else dupBatch++;
      log(`[dedup] drop "${job.job_title}" @ ${job.company_name} — duplicate (${key})`);
      continue;
    }
    const rKey = repostKey(job);
    if (seenReposts.has(rKey)) {
      reposts++;
      log(`[dedup] drop "${job.job_title}" @ ${job.company_name} — repost of an existing row (fresh job_id ${job.job_id || "?"})`);
      continue;
    }
    seen.add(key);
    seenReposts.add(rKey);
    kept.push(job);
  }
  return { kept, dupCache, dupBatch, reposts };
}

async function main() {
  console.log(`[dedup] profile=${resolveProfileName()}`);
  const { filteredJobs: IN, newJobs: OUT } = paths();
  let jobs;
  try {
    jobs = JSON.parse(await readFile(IN, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse ${IN}: ${err.message}`);
  }
  if (!Array.isArray(jobs)) throw new Error(`${IN} must be a JSON array`);

  const cache = await readCache();
  const { kept, dupCache, dupBatch, reposts } = dedupJobs(jobs, cache.jobs);

  await writeFile(OUT, JSON.stringify(kept, null, 2) + "\n");
  console.log(
    `[dedup] ${jobs.length} in → ${kept.length} new (${dupCache} in cache, ${dupBatch} intra-batch, ${reposts} repost) → new_jobs.json`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[dedup] FAILED: ${err.message}`);
    process.exit(1);
  });
}
