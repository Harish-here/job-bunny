---
description: Deterministic 100-pt scorer — adds excitement_level + match_reasons to new_jobs.json.
---

If a profile name was given as `$ARGUMENTS`, prefix with it:

```bash
JOBBUNNY_PROFILE=<profile> node scripts/rank.js   # with profile argument
node scripts/rank.js                              # default profile / legacy
```

Pure arithmetic, no LLM, no network. Needs the profile's `resume_meta.json` (run `/update-resume <profile>` if stale). Report each job's score + excitement band.
