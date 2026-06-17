---
description: Regenerate resume_meta.json from resume.json (JSON-only; no PDF parsing).
---

```bash
node scripts/generate_meta.js
```

Direct field copy from `resume.json` (no inference). Run this whenever you edit `resume.json`. PDF→JSON parsing is **not** part of this path — that is a one-time `/setup` step only.
