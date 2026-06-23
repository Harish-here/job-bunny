---
description: Add a LinkedIn saved-search URL — strips ephemeral params, files it under the right page node.
---

```bash
node scripts/add_url.js "<paste the full LinkedIn search URL>" "<short label>"
```

Cleans the URL — strips ephemeral params (`currentJobId`, `referralSearchId`, `origin`, `originToLandingJobPostings`, `savedSearchId`, `alertAction`, `trackingId`, `refId`, `eBP`, `start`), drops stale absolute `f_TPR=a<epoch>-` date anchors (keeps relative `r<sec>` windows). Keeps the stable filter params and preserves the original path. Then appends under its Channel → page node in `search_urls.md`. Warns if that page-type has no `page_inventory/<page>.md` yet (run `/page-analyse` before `/run`).
