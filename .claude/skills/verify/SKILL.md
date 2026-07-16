---
name: verify
description: Repo-specific recipe for driving Job Bunny's pipeline scripts at runtime instead of only unit-testing them.
---

# Verifying Job Bunny changes

Most pipeline stages (`scripts/pipeline/*.js`) are plain Node CLIs invoked as
`JOBBUNNY_PROFILE=<profile> node scripts/pipeline/<stage>.js`. To verify a change
at runtime without touching real profile data or the shared `.chrome-debug/`
Chrome session:

## Isolated throwaway profile

Never run a test invocation against `profiles/harish/` or `profiles/uvashree/`
directly — create `profiles/_verify_test/` instead, seed only the files the
stage under test actually needs, and `rm -rf` it when done. `scripts/lib/config.js`
resolves everything through `JOBBUNNY_PROFILE`, so this is a faithful stand-in.

`extract.js` needs, at minimum:
- `avoid.md` (can be near-empty — just needs to parse)
- `search_urls.md` (one `## Channel` / `### page` / `- label - https://...` group is enough)
- `filter_config.json` — **read synchronously at module import time** by
  `scripts/pipeline/title_filter.js`, so it must exist before the process even
  starts, not just before the code path you're testing runs. Minimal shape:
  `{"title_filter": {"seniority": [...], "domain": [...], "function": {"allow": [...], "block": []}}}`.
- `data/` fixtures (`extract_resume.json`, `jobs_raw_text.json`, `companies_seen.json`)
  if testing resume/reset behavior.

## extract.js and Chrome — the trap

`extract.js` owns Chrome's lifecycle end-to-end (`ensureChrome()` at the
`connect-cdp` checkpoint). If you run it for real, it launches the actual
shared `.chrome-debug/` profile Chrome — the same one `harish`/`uvashree` use
for their live LinkedIn session. A SIGTERM sent right as the `connect-cdp`
checkpoint appears in the log is **not fast enough** to reliably preempt the
launch, and `killChrome()` in `teardown()` doesn't always catch it either (it
looks up the PID via the CDP port, which may not be listening yet). Expect a
real Chrome window to spawn even when you kill within ~50ms of the checkpoint.

**Always check for and clean up afterward:**
```bash
ps aux | grep "remote-debugging-port=9222" | grep -v grep
# if found:
kill -TERM <pid>; sleep 3; kill -0 <pid> 2>/dev/null && kill -KILL <pid>
```

To test code that runs *before* `connect-cdp` (e.g. resume/reset logic), poll
the run's log file (`profiles/<profile>/data/logs/extract_<ts>.log`) for the
checkpoint line just before the part you're testing (e.g.
`"resume: starting fresh"`), give it ~0.3s to let async writes land, then
SIGTERM. This reliably interrupts before Chrome launch.

## A/B against unpatched code

`git stash` the fix, rerun the identical seeded scenario, observe the (broken)
before-behavior, `git stash pop` to restore. This is the strongest evidence
that a fix actually causes the observed before/after difference, not just
that the after-state looks right in isolation.
