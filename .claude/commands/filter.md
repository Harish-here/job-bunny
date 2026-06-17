---
description: Stage B filter — drop on-site!=Chennai and remote-with-incompatible-hours. jobs_raw.json → filtered_jobs.json.
---

```bash
node scripts/filter.js
```

Hard drops only; absence of timezone never drops. Report kept/dropped counts.
