---
description: Run the full v0 pipeline end-to-end, manually. Hard-aborts on red /doctor; skips a broken page-group and continues.
---

Orchestrate the daily pipeline in order. v0 is triggered manually (scheduled/headless runs are a roadmap item). Run each stage; on a **page-group assertion failure during extract, skip that group and continue** — one stale selector must never kill the whole run. Collect a run summary at the end.

Stage sequence:

1. **/doctor** — `node scripts/doctor.js`. Stop the run if any check is red.
2. **/reconcile** — `node scripts/cache.js` (rebuild cache from Notion).
3. **/extract** — `node scripts/extract.js` (browser; Stage A avoid-drop; skip-broken-group-and-continue). Requires `/doctor` green — do not proceed if step 1 was red.
4. **/structure** — invoke the `/structure` skill. Do NOT write custom code.
5. **/filter** — `node scripts/filter.js` (Stage B).
6. **/dedup** — `node scripts/dedup.js`.
7. **/rank** — `node scripts/rank.js`.
8. **/sync** — `node scripts/notion_sync.js` (push automated fields; update cache + last_run).

After the run, print a summary: URLs processed, page-groups skipped (with reason), jobs extracted → structured → filtered → new → synced, and the top excitement bands. If any single stage fails hard (not a skippable page-group), stop and surface the error rather than pushing partial data.
