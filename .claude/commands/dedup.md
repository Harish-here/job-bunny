---
description: Dedup against the reconciled cache by job_id (fallback role+company). filtered_jobs.json → new_jobs.json.
---

```bash
node scripts/dedup.js
```

Reads `data/cache.json` (reconcile first via `/reconcile`). Report new vs duplicate counts.
