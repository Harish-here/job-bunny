---
description: Archive stale Notion jobs — Passed older than 7 days, untouched leads (no Status) older than 30 (dry-run by default). Not part of /run.
---

Run the cleanup stage. If a profile name was given as `$ARGUMENTS`, prefix with it:

```bash
JOBBUNNY_PROFILE=<profile> node scripts/cleanup.js            # dry-run, default profile
JOBBUNNY_PROFILE=<profile> node scripts/cleanup.js --apply    # actually archive
CLEANUP_DAYS_OLD=14 JOBBUNNY_PROFILE=<profile> node scripts/cleanup.js --apply        # override Passed age
CLEANUP_LEAD_DAYS_OLD=60 JOBBUNNY_PROFILE=<profile> node scripts/cleanup.js --apply   # override stale-lead age
```

Queries the profile's live Notion DB (read-only) for two rule sets, both aged from `Date Found` (when the job was first synced):

- **passed** — `Status = Passed` older than `CLEANUP_DAYS_OLD` (default 7). Age is from `Date Found`, not from when Status was set to `Passed`.
- **stale lead** — pages with **no Status at all** older than `CLEANUP_LEAD_DAYS_OLD` (default 30). Sync never writes Status, so an empty Status means the row was never triaged; setting any Status manually (`Lead`, `Applied`, …) exempts a row from this rule.

Without `--apply` (or `CLEANUP_APPLY=1`) it only lists matches — nothing is written to Notion. With `--apply` it archives each match (`archived: true`), which moves it to Notion's own trash: recoverable for 30 days, then Notion permanently deletes it.

No cache.json cleanup needed — run `/reconcile` afterward and the mirror will naturally drop archived pages, since Notion's default query excludes them.

Requires `NOTION_TOKEN` in `.env` and the profile's `profile.json` (run `/setup <profile>` first). Report the count found/archived per rule and stop on any error.
