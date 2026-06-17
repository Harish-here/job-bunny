---
description: Run the full v0 pipeline end-to-end, manually. Skips a broken page-group and continues.
---

Orchestrate the daily pipeline in order. v0 is triggered manually (scheduled/headless runs are a roadmap item). Run each stage; on a **page-group assertion failure during extract, skip that group and continue** — one stale selector must never kill the whole run. Collect a run summary at the end.

Stage sequence:

1. **/reconcile** — `node scripts/cache.js` (rebuild cache from Notion).
2. **/extract** — `node scripts/extract.js` (browser; Stage A avoid-drop; skip-broken-group-and-continue). Requires `/doctor` green.
3. **/structure** — inline LLM: `jobs_raw_text.json` → `jobs_raw.json` (you do this directly; no script).
4. **/filter** — `node scripts/filter.js` (Stage B).
5. **/dedup** — `node scripts/dedup.js`.
6. **/rank** — `node scripts/rank.js`.
7. **/sync** — `node scripts/notion_sync.js` (push automated fields; update cache + last_run).

After the run, print a summary: URLs processed, page-groups skipped (with reason), jobs extracted → structured → filtered → new → synced, and the top excitement bands. If any single stage fails hard (not a skippable page-group), stop and surface the error rather than pushing partial data.
