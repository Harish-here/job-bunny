// scripts/cleanup.js — archive stale jobs in Notion (manual trigger, not part of /run).
// Two rules, both keyed on Date Found and read-only by default:
//   passed      — Status=Passed pages older than CLEANUP_DAYS_OLD (default 7)
//   stale lead  — pages with NO Status at all (never triaged; sync never writes Status) older
//                 than CLEANUP_LEAD_DAYS_OLD (default 30). Any manually set Status exempts a row.
// Matches are archived (archived:true — Notion's own trash, recoverable for 30 days) only when
// run with --apply / CLEANUP_APPLY=1.
//
// Nothing needs to touch data/cache.json here: Notion's databases.query excludes archived pages
// by default, so the next /reconcile naturally drops them from the local mirror.

import "dotenv/config";
import { Client } from "@notionhq/client";
import { loadProfile, resolveProfileName } from "./config.js";

const DAYS_OLD = parseInt(process.env.CLEANUP_DAYS_OLD || "7", 10);
const LEAD_DAYS_OLD = parseInt(process.env.CLEANUP_LEAD_DAYS_OLD || "30", 10);
const APPLY = process.argv.includes("--apply") || !!process.env.CLEANUP_APPLY;

function cutoffISO(daysOld) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysOld);
  return cutoff.toISOString().slice(0, 10);
}

async function findStaleJobs(notion, dbId, statusFilter, cutoff) {
  const matches = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: dbId,
      start_cursor: cursor,
      page_size: 100,
      filter: {
        and: [
          { property: "Status", select: statusFilter },
          { property: "Date Found", date: { before: cutoff } },
        ],
      },
    });
    matches.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return matches;
}

async function archiveMatches(notion, pages, label) {
  for (const page of pages) {
    const P = page.properties;
    const title = P["Job Title"]?.title?.[0]?.plain_text || "?";
    const company = P["Company"]?.rich_text?.[0]?.plain_text || "?";
    const dateFound = P["Date Found"]?.date?.start || "?";
    console.log(`[cleanup] ${APPLY ? "archiving" : "found"} (${label}): ${title} @ ${company} (found ${dateFound})`);
    if (APPLY) await notion.pages.update({ page_id: page.id, archived: true });
  }
}

async function main() {
  console.log(
    `[cleanup] profile=${resolveProfileName()} days_old=${DAYS_OLD} lead_days_old=${LEAD_DAYS_OLD} apply=${APPLY}`
  );
  const token = process.env.NOTION_TOKEN;
  const dbId = loadProfile().notion_db_id;
  if (!token || !dbId) throw new Error("NOTION_TOKEN / Notion DB id missing — run /setup first.");

  const notion = new Client({ auth: token });
  const passed = await findStaleJobs(notion, dbId, { equals: "Passed" }, cutoffISO(DAYS_OLD));
  const staleLeads = await findStaleJobs(notion, dbId, { is_empty: true }, cutoffISO(LEAD_DAYS_OLD));

  await archiveMatches(notion, passed, "passed");
  await archiveMatches(notion, staleLeads, "stale lead");

  const total = passed.length + staleLeads.length;
  if (!total) {
    console.log(
      `[cleanup] nothing to do — no Passed job(s) older than ${DAYS_OLD} day(s), no untouched lead(s) older than ${LEAD_DAYS_OLD} day(s)`
    );
  } else if (APPLY) {
    console.log(`[cleanup] archived ${total} job(s) (${passed.length} passed, ${staleLeads.length} stale lead)`);
  } else {
    console.log(
      `[cleanup] found ${total} job(s) (${passed.length} passed, ${staleLeads.length} stale lead) — dry-run, pass --apply to archive`
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[cleanup] FAILED: ${err.message}`);
    process.exit(1);
  });
}
