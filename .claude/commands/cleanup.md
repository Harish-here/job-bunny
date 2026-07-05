---
description: Archive Notion jobs marked Passed that are older than 7 days (dry-run by default). Not part of /run.
---

Run the cleanup stage. If a profile name was given as `$ARGUMENTS`, prefix with it:

```bash
JOBBUNNY_PROFILE=<profile> node scripts/cleanup.js            # dry-run, default profile
JOBBUNNY_PROFILE=<profile> node scripts/cleanup.js --apply    # actually archive
CLEANUP_DAYS_OLD=14 JOBBUNNY_PROFILE=<profile> node scripts/cleanup.js --apply   # override age threshold
```

Queries the profile's live Notion DB (read-only) for pages where `Status = Passed` and `Date Found` is older than `CLEANUP_DAYS_OLD` (default 7). Without `--apply` (or `CLEANUP_APPLY=1`) it only lists matches — nothing is written to Notion. With `--apply` it archives each match (`archived: true`), which moves it to Notion's own trash: recoverable for 30 days, then Notion permanently deletes it. Age is measured from `Date Found` (when the job was first synced), not from when Status was set to `Passed`.

No cache.json cleanup needed — run `/reconcile` afterward and the mirror will naturally drop archived pages, since Notion's default query excludes them.

Requires `NOTION_TOKEN` in `.env` and the profile's `profile.json` (run `/setup <profile>` first). Report the count found/archived and stop on any error.
