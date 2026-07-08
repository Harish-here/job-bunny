---
description: (Re)generate and install this machine's launchd jobs from each profile's `schedule` field in profile.json.
---

Regenerate launchd LaunchAgents for scheduled headless `/run` invocations:

```bash
node scripts/schedule.js
```

Reads every `profiles/<name>/profile.json`. Profiles with `schedule.enabled: true` declare
either a single `schedule.time` (`"HH:MM"`, 24h) or multiple via `schedule.times`
(`["HH:MM", ...]`) for a same-day multi-fire cadence — e.g. every 2.5h through working
hours via `["09:00", "11:30", "14:00", "16:30", "19:00"]`. A profile is registered under
every time it lists. All profiles are then grouped by identical time into one launchd job
per distinct time — profiles sharing a time run strictly sequentially inside
`scripts/run_scheduled.sh`, since they share one Chrome/CDP session (CLAUDE.md:
".chrome-debug/ — one Chrome/LinkedIn session") and can never run concurrently. Installs
weekday-only (Mon–Fri) jobs into `~/Library/LaunchAgents/com.jobbunny.run.<HHMM>.plist` via
`launchctl bootstrap`; removes any previously-installed job whose time no longer matches a
profile.

This command takes no profile argument — unlike stage commands, scheduling is inherently
whole-machine (grouping crosses profile boundaries), so it always reads every profile.
Re-run any time you edit a profile's `schedule.time`/`enabled` to apply the change.

Each scheduled firing runs `claude -p "/run <profile>" --dangerously-skip-permissions`
headlessly — see `run.md` for the stage sequence. Per-profile logs land in
`profiles/<name>/data/logs/run_<timestamp>.log`; a pass/fail macOS notification fires per
profile. Scheduler-level logs (PATH/bootstrap failures before the wrapper's own logging
starts) land in `~/Library/Logs/JobBunny/`.

Prerequisite unchanged from a manual run: Chrome must reach an already-logged-in
LinkedIn session in `.chrome-debug/` at run time — `/doctor` red still hard-aborts
`/run`, unattended or not.

**Mac asleep at the scheduled time:** launchd fires a missed job once on wake, coalescing
any missed intervals into a single firing (no duplicates) — no action needed if the
machine is opened at some point that day. For a Mac that regularly sleeps through the
scheduled time, a one-time `sudo pmset repeat wakeorpoweron MTWRF <HH:MM:SS>` pre-wakes it
a few minutes early. Requires the user to already be logged in (screen-locked is fine, a
full logout is not) and works most reliably on AC power if the lid is closed.
