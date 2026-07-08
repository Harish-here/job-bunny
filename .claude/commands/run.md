---
description: Run the full v0 pipeline end-to-end for a profile, manually. Hard-aborts on red /doctor; skips a broken page-group and continues.
---

Orchestrate the daily pipeline in order. Triggered manually, or headlessly by launchd via `/schedule` (`scripts/run_scheduled.sh` → `claude -p "/run <profile>" --dangerously-skip-permissions`) — same stage sequence either way. `run_scheduled.sh` sets `JOBBUNNY_HEADLESS=1` when invoking `claude`, and forwards its own Telegram digest after this process exits — check for that variable before forwarding yourself (see the summary/failure sections below) so headless runs don't get double-notified.

**Step 0 — resolve the profile.** If `$ARGUMENTS` has a profile name, use it. Otherwise read `default_profile` from `config.json` (no `config.json` = legacy layout, no profile). State which profile the run is for before starting. When a profile was given, prefix **every** `node` command below with `JOBBUNNY_PROFILE=<profile>` — each bash call is a fresh shell, so repeat the prefix every time; never rely on `export`.

Run each stage; on a **page-group assertion failure during extract, skip that group and continue** — one stale selector must never kill the whole run. Collect a run summary at the end. Stage files live in `profiles/<profile>/data/` (legacy: repo root).

**Never background a stage command (no `run_in_background`), even if it's slow.** Every `node scripts/*.js` call below must run in the foreground and be waited on before moving to the next stage. This matters most for headless/scheduled runs: `run_scheduled.sh` invokes this command via `claude -p ... --dangerously-skip-permissions`, a single-shot non-interactive call — if a stage is backgrounded on the promise of "I'll be notified when it finishes," that notification can never arrive because the process exits at the end of this one turn, silently truncating the whole run right after the backgrounded stage starts (with no error, no summary, no `mark_run_result.js` call). Extract is the slowest stage and the one most tempting to background — run it synchronously regardless.

Stage sequence:

1. **/doctor** — `node scripts/doctor.js`. Stop the run if any check is red.
2. **/reconcile** — `node scripts/cache.js` (rebuild the profile's cache from its Notion DB).
3. **/extract** — `node scripts/extract.js` (browser; Stage A avoid-drop; skip-broken-group-and-continue). Requires `/doctor` green — do not proceed if step 1 was red. Output: `jobs_raw_text.json`, plus `data/companies_seen.json` for the greenhouse lane below.
4. **/greenhouse** — `node scripts/greenhouse.js` (keyless Greenhouse boards API lane; probes new companies from `companies_seen.json`, fetches curated/auto-discovered boards, appends to `jobs_raw_text.json`). **Fail-soft, like a skipped page-group**: an absent watchlist or a whole-lane network failure exits 0 and must NOT stop the run — note it in the Run Summary instead of treating it as a hard failure.
5. **compress** — `node scripts/compress.js` (sanitise raw_text; emit compact markdown table). Output: `structure_input.md` + `structure_passthrough.json`.
6. **/structure** — invoke the `/structure` skill **for this profile**. Do NOT write custom code. Reads the profile's `structure_input.md`; checkpoints every 25 rows to `jobs_raw_checkpoint.md`; writes `jobs_raw_decisions.md`.
7. **assemble** — `node scripts/assemble.js` (merge LLM decisions with passthrough fields). Output: `jobs_raw.json`.
8. **/filter** — `node scripts/filter.js` (Stage B; home city from the profile's resume_meta).
9. **/dedup** — `node scripts/dedup.js`.
10. **/rank** — `node scripts/rank.js`.
11. **/sync** — `node scripts/notion_sync.js` (push automated fields to the profile's DB; update cache + last_run).

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

After printing the summary, **always** mark the run's outcome explicitly, regardless of headless vs. interactive — `run_scheduled.sh` reads this file to decide PASSED/FAILED, rather than inferring it from this summary's wording, so it must be a literal command, not paraphrased: `JOBBUNNY_PROFILE=<profile> node scripts/mark_run_result.js --status success`.

Then decide whether to forward the digest to Telegram yourself: check `echo "${JOBBUNNY_HEADLESS:-}"` — if it printed `1`, this is a headless/scheduled run and `run_scheduled.sh` will send its own Telegram digest after this process exits, so **skip forwarding** (sending it here too would double-notify). If it printed nothing (interactive `/run`, no wrapper watching), forward it yourself: shell out with `JOBBUNNY_PROFILE=<profile> node scripts/notify.js --severity success --body "<the exact summary text just printed>"`. No `--title` — the Run Summary body already opens with its own bold heading, and the Telegram formatter's banner already carries the profile name, so a separate title would just be a redundant second headline.

If any single stage fails hard (not a skippable page-group), stop and surface the error rather than pushing partial data — skip the summary template in that case and report the failure directly. Mark the outcome the same way (always, headless or not): `JOBBUNNY_PROFILE=<profile> node scripts/mark_run_result.js --status failed --message "<short failure reason>"`. Then apply the same `JOBBUNNY_HEADLESS` check before forwarding a failure digest: `JOBBUNNY_PROFILE=<profile> node scripts/notify.js --severity blocking --title "Run failed" --body "<the failure just reported>"` — only if not headless. These two mark/forward pairs are mutually exclusive per run (success xor failure) — never send both.
