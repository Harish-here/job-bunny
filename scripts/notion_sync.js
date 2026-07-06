// scripts/notion_sync.js — push new_jobs.json to Notion, then update the cache mirror.
// Writes AUTOMATED FIELDS ONLY (from schema.js) — manual tracking fields (Status, Notes, etc.)
// are never set, so a human's tracking data is never clobbered. Insert-only (pages.create);
// no whole-page overwrite, no delete.
//
// Idempotent on its own: jobs already present in the cache (by dedupKey) are skipped, so a
// re-run pushes zero duplicates even if dedup wasn't re-run first.
//
// new_jobs.json → Notion rows; updates data/cache.json + last_run.

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Client } from "@notionhq/client";
import { dedupKey } from "./util.js";
import { readCache, writeCache } from "./cache.js";
import { paths, loadProfile, resolveProfileName } from "./config.js";
import { notify } from "./notify.js";

const IN = paths().newJobs;

const rt = (s) => [{ type: "text", text: { content: String(s ?? "") } }];

// Map a ranked job to Notion properties — automated fields only.
function buildProperties(job) {
  const props = {
    "Job Title": { title: rt(job.job_title) },
    Company: { rich_text: rt(job.company_name) },
    "Location City": { rich_text: rt(job.location_city) },
    "Key Skills": { rich_text: rt((job.key_skills || []).join(", ")) },
    "YoE Is Minimum": { checkbox: !!job.yoe_is_minimum },
    "Match Reasons": { rich_text: rt((job.match_reasons || []).join("\n")) },
  };
  if (typeof job.years_of_experience === "number") props.YoE = { number: job.years_of_experience };
  if (job.job_url) props["Job URL"] = { url: job.job_url };
  if (job.source_query_url) props["Source URL"] = { url: job.source_query_url };
  if (job.date_found) props["Date Found"] = { date: { start: job.date_found } };
  if (job.seniority_level) props["Seniority Level"] = { select: { name: job.seniority_level } };
  if (job.work_type) props["Work Type"] = { select: { name: job.work_type } };
  if (job.timezone_compatibility) props.Timezone = { select: { name: job.timezone_compatibility } };
  if (job.excitement_level) props.Excitement = { select: { name: job.excitement_level } };
  return props;
}

async function main() {
  console.log(`[sync] profile=${resolveProfileName()}`);
  const token = process.env.NOTION_TOKEN;
  const dbId = loadProfile().notion_db_id;
  if (!token || !dbId) throw new Error("NOTION_TOKEN / Notion DB id missing — run /setup first.");

  let jobs;
  try {
    jobs = JSON.parse(await readFile(IN, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse ${IN}: ${err.message}`);
  }
  if (!Array.isArray(jobs)) throw new Error(`${IN} must be a JSON array`);

  const notion = new Client({ auth: token });
  const cache = await readCache();
  const seen = new Set(cache.jobs.map(dedupKey));

  let inserted = 0;
  let skipped = 0;
  let syncError = null;
  let remaining = 0;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const key = dedupKey(job);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    try {
      const page = await notion.pages.create({ parent: { database_id: dbId }, properties: buildProperties(job) });
      seen.add(key);
      cache.jobs.push({ ...job, notion_page_id: page.id });
      inserted++;
      console.log(`[sync] + ${job.excitement_level || "?"}  ${job.job_title} @ ${job.company_name}`);
      // Incremental flush after every successful insert — a mid-loop failure (rate-limit,
      // auth, a bad select value) never loses already-inserted jobs from the cache mirror,
      // which would otherwise cause duplicate Notion rows on retry.
      await writeCache(cache);
    } catch (err) {
      syncError = err;
      remaining = jobs.length - i - 1; // jobs not attempted after this one
      console.error(`[sync] FAILED inserting "${job.job_title}" @ ${job.company_name}: ${err.message}`);
      break; // a rate-limit/auth error will likely repeat — don't burn through the rest
    }
  }

  cache.last_run = new Date().toISOString();
  await writeCache(cache);
  console.log(`[sync] inserted ${inserted}, skipped ${skipped} (already in cache); cache now ${cache.jobs.length} job(s)`);

  if (syncError) {
    await notify({
      severity: "blocking",
      title: "Notion sync failed",
      body:
        `${inserted} inserted, ${skipped} skipped, ${remaining} not attempted — cache safe to retry. ` +
        `Error: ${syncError.message}`,
    });
    throw syncError;
  }
}

main().catch((err) => {
  console.error(`[sync] FAILED: ${err.message}`);
  process.exit(1);
});
