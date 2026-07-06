---
description: Run the full v0 pipeline end-to-end for a profile, manually. Hard-aborts on red /doctor; skips a broken page-group and continues.
---

Orchestrate the daily pipeline in order. Triggered manually, or headlessly by launchd via `/schedule` (`scripts/run_scheduled.sh` → `claude -p "/run <profile>" --dangerously-skip-permissions`) — same stage sequence either way.

**Step 0 — resolve the profile.** If `$ARGUMENTS` has a profile name, use it. Otherwise read `default_profile` from `config.json` (no `config.json` = legacy layout, no profile). State which profile the run is for before starting. When a profile was given, prefix **every** `node` command below with `JOBBUNNY_PROFILE=<profile>` — each bash call is a fresh shell, so repeat the prefix every time; never rely on `export`.

Run each stage; on a **page-group assertion failure during extract, skip that group and continue** — one stale selector must never kill the whole run. Collect a run summary at the end. Stage files live in `profiles/<profile>/data/` (legacy: repo root).

Stage sequence:

1. **/doctor** — `node scripts/doctor.js`. Stop the run if any check is red.
2. **/reconcile** — `node scripts/cache.js` (rebuild the profile's cache from its Notion DB).
3. **/extract** — `node scripts/extract.js` (browser; Stage A avoid-drop; skip-broken-group-and-continue). Requires `/doctor` green — do not proceed if step 1 was red. Output: `jobs_raw_text.json`.
4. **compress** — `node scripts/compress.js` (sanitise raw_text; emit compact markdown table). Output: `structure_input.md` + `structure_passthrough.json`.
5. **/structure** — invoke the `/structure` skill **for this profile**. Do NOT write custom code. Reads the profile's `structure_input.md`; checkpoints every 25 rows to `jobs_raw_checkpoint.md`; writes `jobs_raw_decisions.md`.
6. **assemble** — `node scripts/assemble.js` (merge LLM decisions with passthrough fields). Output: `jobs_raw.json`.
7. **/filter** — `node scripts/filter.js` (Stage B; home city from the profile's resume_meta).
8. **/dedup** — `node scripts/dedup.js`.
9. **/rank** — `node scripts/rank.js`.
10. **/sync** — `node scripts/notion_sync.js` (push automated fields to the profile's DB; update cache + last_run).

After the run, print a summary in this exact template (fill in real values; omit the Notes line if there's nothing noteworthy):

```
## Run Summary — profile: <profile>

- **URLs processed:** <n> (<breakdown by page-group type>)
- **Page-groups skipped:** <n> (with reason, or 0)
- **Jobs extracted → structured → filtered → new → synced:** <a> → <b> → <c> → <d> → <e>

**Top excitement bands (ranked):**
| Score | Title | Company |
|---|---|---|
| <score> | <title> | <company> |
...

Notes:
- <anything noteworthy: cache size swings, heavy dedup collapse, filter drops with reasons, etc.>
```

After printing the summary, forward the same digest to Telegram (best-effort — this mirrors what `run_scheduled.sh` does for headless runs, so interactive `/run` gets the same notification): shell out with `JOBBUNNY_PROFILE=<profile> node scripts/notify.js --severity success --body "<the exact summary text just printed>"`. No `--title` — the Run Summary body already opens with its own bold heading, and the Telegram formatter's banner already carries the profile name, so a separate title would just be a redundant second headline.

If any single stage fails hard (not a skippable page-group), stop and surface the error rather than pushing partial data — skip the summary template in that case and report the failure directly. Also forward a failure digest to Telegram the same way: `JOBBUNNY_PROFILE=<profile> node scripts/notify.js --severity blocking --title "Run failed" --body "<the failure just reported>"`. These two forwarding calls are mutually exclusive per run (success xor failure) — never send both.
