---
description: Stage B filter — drop on-site outside the profile's home city (resume_meta location) and remote-with-incompatible-hours. jobs_raw.json → filtered_jobs.json.
---

If a profile name was given as `$ARGUMENTS`, prefix with it:

```bash
JOBBUNNY_PROFILE=<profile> node scripts/filter.js   # with profile argument
node scripts/filter.js                              # default profile / legacy
```

Hard drops only; absence of timezone never drops. Home city comes from the profile's `resume_meta.json` `location`. Report kept/dropped counts.
