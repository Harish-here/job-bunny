---
description: Run the full v0 pipeline end-to-end for a profile. Thin wrapper over scripts/ops/orchestrate.js, which spawns every stage (doctor → sync) as a blocking child and owns watchdog/retry/failure-capture.
---

Run the daily pipeline for a profile. This command is a thin wrapper: the whole pipeline —
doctor, reconcile, extract, greenhouse, keka, compress, structure, assemble, filter, dedup,
rank, sync — is run by `scripts/ops/orchestrate.js`, a single node process that spawns each stage
as a foreground child and owns the watchdog, retry, stall-detection, and failure-capture.
`/structure` is spawned by orchestrate as `claude -p`, not invoked inline here.

**Step 0 — resolve the profile.** If `$ARGUMENTS` names a profile, use it. Otherwise read
`default_profile` from `config.json` (no `config.json` = not set up — stop and point at
`/setup`). State which profile the run is for before starting.

**Step 1 — run the orchestrator in the FOREGROUND.** One blocking process — do NOT background it
(no `run_in_background`), do not wrap it, do not re-implement any stage:

    JOBBUNNY_PROFILE=<profile> node scripts/ops/orchestrate.js --profile <profile>

orchestrate writes `profiles/<profile>/data/last_run_result.json`, and on success prints a
`## Run Summary — profile: <profile>` block on stdout. Its exit code is the outcome (0 = passed,
non-zero = failed).

**Step 2 — relay the result.** Relay orchestrate's `## Run Summary` block verbatim on success. On
a non-zero exit, report the failure line orchestrate printed (`[orchestrate] FAILED — …`) rather
than inventing a summary. Do not call `mark_run_result.js` and do not send Telegram from here —
orchestrate owns the result file and sends the Telegram digest itself (success and failure).
