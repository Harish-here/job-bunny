---
description: Push new_jobs.json to Notion (automated fields only) and update cache.json + last_run.
---

```bash
node scripts/notion_sync.js
```

Inserts one Notion row per job, writing **automated fields only** — manual tracking fields (Status, Notes, etc.) are never touched. Re-running pushes zero duplicates (dedup already ran). Updates `data/cache.json` and `last_run`. Requires `.env` keys.
