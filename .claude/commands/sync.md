---
description: Push new_jobs.json to the profile's Notion DB (automated fields only) and update cache.json + last_run.
---

If a profile name was given as `$ARGUMENTS`, prefix with it:

```bash
JOBBUNNY_PROFILE=<profile> node scripts/notion_sync.js   # with profile argument
node scripts/notion_sync.js                              # default profile
```

Inserts one Notion row per job into the profile's DB, writing **automated fields only** — manual tracking fields (Status, Notes, etc.) are never touched. Re-running pushes zero duplicates (dedup already ran). Updates the profile's `data/cache.json` and `last_run`. Requires `NOTION_TOKEN` in `.env` + the profile's `profile.json`.
