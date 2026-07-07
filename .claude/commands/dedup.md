---
description: Dedup against the reconciled cache by job_id (fallback role+company), and drop fresh-id reposts of tracked jobs. filtered_jobs.json → new_jobs.json.
---

If a profile name was given as `$ARGUMENTS`, prefix with it:

```bash
JOBBUNNY_PROFILE=<profile> node scripts/dedup.js   # with profile argument
node scripts/dedup.js                              # default profile / legacy
```

Reads the profile's `data/cache.json` (reconcile first via `/reconcile`). Two drop classes:

- **Duplicate** — job_id (fallback: normalized role+company) already in the cache or earlier in this batch.
- **Repost** — fresh job_id, but the same normalized role+company+city already exists (LinkedIn reposts get a new id). Dropped; the existing Notion row stands, nothing is updated.

Report new vs duplicate vs repost counts.
