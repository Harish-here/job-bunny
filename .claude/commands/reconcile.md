---
description: Rebuild the profile's cache.json from its live Notion DB (Notion = source of truth). Read-only on Notion.
---

Run the cache reconcile stage. If a profile name was given as `$ARGUMENTS`, prefix with it:

```bash
JOBBUNNY_PROFILE=<profile> node scripts/cache.js   # with profile argument
node scripts/cache.js                              # default profile
```

This rebuilds `profiles/<profile>/data/cache.json` from that profile's live Notion DB before dedup. It never writes to Notion. Requires `NOTION_TOKEN` in `.env` and the profile's `profile.json` (run `/setup <profile>` first). Report the job count and stop on any error.
