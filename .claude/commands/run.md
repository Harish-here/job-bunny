---
description: Run the full v0 pipeline end-to-end, manually. Hard-aborts on red /doctor; skips a broken page-group and continues.
---

Orchestrate the daily pipeline in order. v0 is triggered manually (scheduled/headless runs are a roadmap item). Run each stage; on a **page-group assertion failure during extract, skip that group and continue** — one stale selector must never kill the whole run. Collect a run summary at the end.

Stage sequence:

1. **/doctor** — `node scripts/doctor.js`. Stop the run if any check is red.
2. **/reconcile** — `node scripts/cache.js` (rebuild cache from Notion).
3. **/extract** — `node scripts/extract.js` (browser; Stage A avoid-drop; skip-broken-group-and-continue). Requires `/doctor` green — do not proceed if step 1 was red. Output: `jobs_raw_text.json`.
4. **compress** — `node scripts/compress.js` (pre-filter by title; sanitise raw_text; emit compact markdown table). Output: `structure_input.md` + `structure_passthrough.json`.
5. **/structure** — invoke the `/structure` skill. Do NOT write custom code. Reads `structure_input.md`; checkpoints every 25 rows to `jobs_raw_checkpoint.md`; writes `jobs_raw_decisions.md`.
6. **assemble** — `node scripts/assemble.js` (merge LLM decisions with passthrough fields). Output: `jobs_raw.json`.
7. **/filter** — `node scripts/filter.js` (Stage B).
8. **/dedup** — `node scripts/dedup.js`.
9. **/rank** — `node scripts/rank.js`.
10. **/sync** — `node scripts/notion_sync.js` (push automated fields; update cache + last_run).

After the run, print a summary: URLs processed, page-groups skipped (with reason), jobs extracted → structured → filtered → new → synced, and the top excitement bands. If any single stage fails hard (not a skippable page-group), stop and surface the error rather than pushing partial data.
