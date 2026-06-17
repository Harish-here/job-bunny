---
description: Add a LinkedIn saved-search URL — strips ephemeral params, files it under the right page node.
---

```bash
node scripts/add_url.js "<paste the full LinkedIn search URL>" "<short label>"
```

Strips ephemeral params (`currentJobId`, `referralSearchId`, `origin`, `originToLandingJobPostings`), keeps the stable filter params, and appends the cleaned URL under its Channel → page node in `search_urls.md`. Warns if that page-type has no `page_inventory/<page>.md` yet (run `/page-analyse` before `/run`).
