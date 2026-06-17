---
description: Deterministic 100-pt scorer — adds excitement_level + match_reasons to new_jobs.json.
---

```bash
node scripts/rank.js
```

Pure arithmetic, no LLM, no network. Needs `resume_meta.json` (run `/update-resume` if stale). Report each job's score + excitement band.
