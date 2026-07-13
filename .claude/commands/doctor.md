---
description: Preflight — Chrome/CDP reachable, every page-type has an inventory, cache valid, keys present.
---

If a profile name was given as `$ARGUMENTS`, prefix the command with it; otherwise run plain (uses `config.json` default):

```bash
JOBBUNNY_PROFILE=<profile> node scripts/ops/doctor.js   # with profile argument
node scripts/ops/doctor.js                              # default profile
```

Read-only. Reports each check and exits non-zero if anything is red. Run before `/run`.
