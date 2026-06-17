---
description: Rebuild data/cache.json from the live Notion DB (Notion = source of truth). Read-only on Notion.
---

Run the cache reconcile stage:

```bash
node scripts/cache.js
```

This rebuilds `data/cache.json` from the live Notion DB before dedup. It never writes to Notion. Requires `NOTION_TOKEN` + `NOTION_DB_ID` in `.env` (run `/setup` first). Report the job count and stop on any error.
