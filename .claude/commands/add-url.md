---
description: Add a LinkedIn saved-search URL — strips ephemeral params, files it under the right page node.
---

`$ARGUMENTS` may start with an optional profile name (a bare `[a-z0-9-]+` token before the URL). If present, pass it as the env var; URL and label stay positional:

```bash
JOBBUNNY_PROFILE=<profile> node scripts/setup/add_url.js "<paste the full LinkedIn search URL>" "<short label>"   # with profile
node scripts/setup/add_url.js "<url>" "<short label>"                                                             # default profile
```

Cleans the URL — strips ephemeral params (`currentJobId`, `referralSearchId`, `origin`, `originToLandingJobPostings`, `savedSearchId`, `alertAction`, `trackingId`, `refId`, `eBP`, `start`), drops stale absolute `f_TPR=a<epoch>-` date anchors (keeps relative `r<sec>` windows). Keeps the stable filter params and preserves the original path. Then appends under its Channel → page node in the profile's `search_urls.md`. Warns if that page-type has no `page_inventory/<page>.md` yet (run `/page-analyse` before `/run`).
