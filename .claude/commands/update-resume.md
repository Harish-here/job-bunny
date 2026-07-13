---
description: Regenerate resume_meta.json from resume.json (JSON-only; no PDF parsing).
---

If a profile name was given as `$ARGUMENTS`, prefix with it:

```bash
JOBBUNNY_PROFILE=<profile> node scripts/setup/generate_meta.js   # with profile argument
node scripts/setup/generate_meta.js                              # default profile
```

Direct field copy from the profile's `resume.json` (no inference). Run this whenever you edit `resume.json`. PDF→JSON parsing is **not** part of this path — that is a one-time `/setup` step only.
