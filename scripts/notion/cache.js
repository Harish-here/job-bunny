// scripts/notion/cache.js — cache read/write helpers + reconcile().
// Notion is the source of truth; data/cache.json is a perf mirror. reconcile() rebuilds the
// mirror from the live Notion DB at run start. It NEVER writes to Notion.
//
// As a module: import { readCache, writeCache, reconcile }.
// Run directly (`node scripts/notion/cache.js`, i.e. /reconcile): reconcile against live Notion.

import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@notionhq/client";
import { extractJobId } from "../lib/util.js";
import { paths, loadProfile } from "../lib/config.js";

// Cache path resolved at call time, not module load — importing these helpers must not
// require an active profile.
export async function readCache() {
  try {
    return JSON.parse(await readFile(paths().cache, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`[cache] cache.json unreadable (${err.message}) — treating as empty`);
    return { last_run: null, jobs: [] };
  }
}

export async function writeCache(cache) {
  await writeFile(paths().cache, JSON.stringify(cache, null, 2) + "\n");
}

// --- Notion property readers ---
const plain = (rich) => (rich || []).map((t) => t.plain_text).join("");
const propText = (p) => (p?.type === "rich_text" ? plain(p.rich_text) : p?.type === "title" ? plain(p.title) : "");
const propSelect = (p) => p?.select?.name ?? null;
const propNumber = (p) => (typeof p?.number === "number" ? p.number : null);
const propCheckbox = (p) => !!p?.checkbox;
const propUrl = (p) => p?.url ?? null;
const propDate = (p) => p?.date?.start ?? null;

// Map a Notion page to the job shape the pipeline uses. job_id is derived from the Job URL
// (G6) since the DB has no job_id column.
function pageToJob(page) {
  const P = page.properties;
  const job_url = propUrl(P["Job URL"]);
  const skills = propText(P["Key Skills"]);
  return {
    job_id: extractJobId(job_url),
    job_title: propText(P["Job Title"]),
    company_name: propText(P["Company"]),
    seniority_level: propSelect(P["Seniority Level"]),
    location_city: propText(P["Location City"]),
    work_type: propSelect(P["Work Type"]),
    years_of_experience: propNumber(P["YoE"]),
    yoe_is_minimum: propCheckbox(P["YoE Is Minimum"]),
    key_skills: skills ? skills.split(",").map((s) => s.trim()).filter(Boolean) : [],
    job_url,
    date_found: propDate(P["Date Found"]),
    timezone_compatibility: propSelect(P["Timezone"]),
    source_query_url: propUrl(P["Source URL"]),
    excitement_level: propSelect(P["Excitement"]),
    notion_page_id: page.id,
  };
}

// Rebuild cache.json from the live Notion DB. Preserves last_run (set by notion_sync).
export async function reconcile({ token = process.env.NOTION_TOKEN, dbId = loadProfile().notion_db_id } = {}) {
  if (!token) throw new Error("NOTION_TOKEN missing — run /setup first.");
  if (!dbId) throw new Error("Notion DB id missing — run /setup first.");

  const notion = new Client({ auth: token });
  const jobs = [];
  let cursor;
  do {
    const res = await notion.databases.query({ database_id: dbId, start_cursor: cursor, page_size: 100 });
    for (const page of res.results) jobs.push(pageToJob(page));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  const prev = await readCache();
  const cache = { last_run: prev.last_run ?? null, jobs };
  await writeCache(cache);
  return cache;
}

// Run directly → /reconcile
if (import.meta.url === `file://${process.argv[1]}`) {
  reconcile()
    .then((c) => console.log(`[reconcile] cache rebuilt from Notion: ${c.jobs.length} job(s)`))
    .catch((err) => {
      console.error(`[reconcile] FAILED: ${err.message}`);
      process.exit(1);
    });
}
