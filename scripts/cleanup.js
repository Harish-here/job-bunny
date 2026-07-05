// scripts/cleanup.js — archive stale "Passed" jobs in Notion (manual trigger, not part of /run).
// Queries Notion directly (read-only by default) for Status=Passed pages with Date Found older
// than CLEANUP_DAYS_OLD (default 7), then archives them (archived:true — Notion's own trash,
// recoverable for 30 days) only when run with --apply / CLEANUP_APPLY=1.
//
// Nothing needs to touch data/cache.json here: Notion's databases.query excludes archived pages
// by default, so the next /reconcile naturally drops them from the local mirror.

import "dotenv/config";
import { Client } from "@notionhq/client";
import { loadProfile, resolveProfileName } from "./config.js";

const DAYS_OLD = parseInt(process.env.CLEANUP_DAYS_OLD || "7", 10);
const APPLY = process.argv.includes("--apply") || !!process.env.CLEANUP_APPLY;

async function findStalePassedJobs(notion, dbId, cutoffISO) {
  const matches = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: dbId,
      start_cursor: cursor,
      page_size: 100,
      filter: {
        and: [
          { property: "Status", select: { equals: "Passed" } },
          { property: "Date Found", date: { before: cutoffISO } },
        ],
      },
    });
    matches.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return matches;
}

async function main() {
  console.log(`[cleanup] profile=${resolveProfileName()} days_old=${DAYS_OLD} apply=${APPLY}`);
  const token = process.env.NOTION_TOKEN;
  const dbId = loadProfile().notion_db_id;
  if (!token || !dbId) throw new Error("NOTION_TOKEN / Notion DB id missing — run /setup first.");

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS_OLD);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  const notion = new Client({ auth: token });
  const pages = await findStalePassedJobs(notion, dbId, cutoffISO);

  for (const page of pages) {
    const P = page.properties;
    const title = P["Job Title"]?.title?.[0]?.plain_text || "?";
    const company = P["Company"]?.rich_text?.[0]?.plain_text || "?";
    const dateFound = P["Date Found"]?.date?.start || "?";
    console.log(`[cleanup] ${APPLY ? "archiving" : "found"}: ${title} @ ${company} (found ${dateFound})`);
    if (APPLY) await notion.pages.update({ page_id: page.id, archived: true });
  }

  if (!pages.length) {
    console.log(`[cleanup] no Passed job(s) older than ${DAYS_OLD} day(s)`);
  } else if (APPLY) {
    console.log(`[cleanup] archived ${pages.length} job(s)`);
  } else {
    console.log(`[cleanup] found ${pages.length} job(s) — dry-run, pass --apply to archive`);
  }
}

main().catch((err) => {
  console.error(`[cleanup] FAILED: ${err.message}`);
  process.exit(1);
});
