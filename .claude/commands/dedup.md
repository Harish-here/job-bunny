---
description: Dedup against the reconciled cache by job_id (fallback role+company). filtered_jobs.json → new_jobs.json.
---

If a profile name was given as `$ARGUMENTS`, prefix with it:

```bash
JOBBUNNY_PROFILE=<profile> node scripts/dedup.js   # with profile argument
node scripts/dedup.js                              # default profile / legacy
```

Reads the profile's `data/cache.json` (reconcile first via `/reconcile`). Report new vs duplicate counts.
