---
name: verify
description: Repo-specific recipe for driving Job Bunny's pipeline scripts at runtime instead of only unit-testing them.
---

# Verifying Job Bunny changes

Most pipeline stages (`scripts/pipeline/*.js`) are plain Node CLIs invoked as
`JOBBUNNY_PROFILE=<profile> node scripts/pipeline/<stage>.js`.

## Default target: profiles/rajni/

`profiles/rajni/` is a committed, synthetic fixture profile — the standard target for
verifying filter/dedup/rank and extract's resume/state logic. It is never used for real
runs (schedule disabled, no Notion IDs, no live LinkedIn scraping) and its data
dictionary (`profiles/rajni/README.md`) documents exactly what each fixture record is for
and what each stage should do with it. Use it instead of `profiles/harish/`/
`profiles/uvashree/` (real user data — never touch these for a test run) or hand-building
a throwaway profile.

```bash
JOBBUNNY_PROFILE=rajni node scripts/pipeline/filter.js
JOBBUNNY_PROFILE=rajni node scripts/pipeline/dedup.js
JOBBUNNY_PROFILE=rajni node scripts/pipeline/rank.js
```

`filter.js`/`dedup.js`/`rank.js` are read-only on their input fixtures — they only write
`filtered_jobs.json`/`new_jobs.json` (untracked per-run intermediates, already covered by
`.gitignore`'s bare-filename rules even under `profiles/rajni/`). If a stage run ever
leaves `profiles/rajni/`'s *committed* files dirty, restore them with:

```bash
git checkout -- profiles/rajni/
```

### Extract's resume/state logic

`extract_resume.json`'s `day` field must equal "today" to test the crash-resume/
already-complete paths, so this fixture is never committed (it would go stale the day
after commit). Generate it on the fly against Rajni's real `search_urls.md`, exercise
`/extract`'s resume decision, then discard:

```bash
TODAY=$(date +%Y-%m-%d)
HASH=$(node -e "
  const fs=require('fs'), crypto=require('crypto');
  const text=fs.readFileSync('profiles/rajni/search_urls.md','utf8');
  console.log('sha256:'+crypto.createHash('sha256').update(text).digest('hex'));
")
cat > profiles/rajni/data/extract_resume.json <<EOF
{
  "day": "$TODAY",
  "search_urls_hash": "$HASH",
  "window_hours": 0,
  "completed": [
    { "page": "linkedin__jobs-search", "url": "https://www.linkedin.com/jobs/search/?keywords=Staff+Frontend+Engineer&f_TPR=r86400&sortBy=R", "finished_at": "${TODAY}T09:00:00.000Z" },
    { "page": "linkedin__jobs-search", "url": "https://www.linkedin.com/jobs/search/?keywords=Lead+Frontend+Engineer&f_TPR=r86400&sortBy=R", "finished_at": "${TODAY}T09:01:00.000Z" }
  ]
}
EOF
echo '[]' > profiles/rajni/data/jobs_raw_text.json
echo '[]' > profiles/rajni/data/companies_seen.json
```

Run `/extract` against it (see "the trap" below for interrupting before Chrome
launches), watch the log for the resume decision line, then discard the generated files:

```bash
git checkout -- profiles/rajni/
```

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

## Fallback: throwaway profile for scenarios Rajni doesn't cover

For a genuinely novel one-off scenario Rajni's fixture doesn't model — or Stage-A
`avoid.js` card-level testing, which operates on pre-assemble data Rajni doesn't have —
create `profiles/_verify_test/` instead, seed only the files the stage under test
actually needs, and `rm -rf` it when done. Never run a test invocation against
`profiles/harish/` or `profiles/uvashree/` directly. `scripts/lib/config.js` resolves
everything through `JOBBUNNY_PROFILE`, so a throwaway profile is a faithful stand-in.

`extract.js` needs, at minimum:
- `avoid.md` (can be near-empty — just needs to parse)
- `search_urls.md` (one `## Channel` / `### page` / `- label - https://...` group is enough)
- `filter_config.json` — **read synchronously at module import time** by
  `scripts/pipeline/title_filter.js`, so it must exist before the process even
  starts, not just before the code path you're testing runs. Minimal shape:
  `{"title_filter": {"seniority": [...], "domain": [...], "function": {"allow": [...], "block": []}}}`.
- `data/` fixtures (`extract_resume.json`, `jobs_raw_text.json`, `companies_seen.json`)
  if testing resume/reset behavior.

## A/B against unpatched code

`git stash` the fix (or `git checkout main -- <files>` if already committed), rerun the
identical scenario against Rajni, observe the (broken) before-behavior, restore the fix.
This is the strongest evidence that a fix actually causes the observed before/after
difference, not just that the after-state looks right in isolation.
