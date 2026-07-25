---
name: verify
description: Repo-specific recipe for driving Job Bunny's v2 pipeline stages at runtime instead of only unit-testing them.
---

# Verifying Job Bunny changes

v2 stages are driven through the `jobbunny` CLI, always under Node 24:

```bash
source ~/.nvm/nvm.sh && nvm use 24
node src/cli/main.ts stage <name> --profile <profile>   # single stage, e.g. filter/dedup/rank/sync/farm/source
node src/cli/main.ts run --profile <profile>             # full pipeline
node src/cli/main.ts reconcile --profile <profile>
node src/cli/main.ts routine cleanup --profile <profile>
```

## Default target: profiles/rajni/

`profiles/rajni/` is a committed, synthetic fixture profile — the standard target for
verifying filter/dedup/rank and the LinkedIn lane's resume/state logic. It is never used for
real runs (schedule disabled, no Notion IDs, no live LinkedIn scraping) and its data
dictionary (`profiles/rajni/README.md`) documents exactly what each fixture record is for.
Use it instead of `profiles/harish/`/`profiles/uvashree/` (real user data — never touch these
for a test run) or hand-building a throwaway profile.

```bash
node src/cli/main.ts stage filter --profile rajni
node src/cli/main.ts stage dedup --profile rajni
node src/cli/main.ts stage rank --profile rajni
```

Every `stage <name>` run resumes from the latest checkpoint in today's
`profiles/rajni/data/runs/<date>/NN-<stage>.json` (falling back to `{ jobs: [], dropped: [] }`
if there is none yet) and writes a new checkpoint at that stage's own slot — `dedup` needs
`reconcile` to have run first this same day (it reads `profiles/rajni/data/cache.json`, not a
checkpoint). If a stage run ever leaves `profiles/rajni/`'s *committed* files dirty, restore
them with:

```bash
git checkout -- profiles/rajni/
```

Per-run intermediates (`data/runs/`, `data/registry/`, `data/lanes/`, `data/cache.json`) are
already gitignored, so a stray run there needs no cleanup.

### The LinkedIn lane's resume/state logic

The lane persists per-URL same-day completion at
`profiles/rajni/data/lanes/linkedin/extract_resume.json` — shape `{ date, done: { <url>:
<count> } }` (`src/adapters/lanes/linkedin/resume_state.ts`). A stale (non-today) `date` or a
missing file starts fresh, so this fixture is never committed. Generate it on the fly to
exercise the crash-resume/already-complete paths, then discard:

```bash
TODAY=$(date +%Y-%m-%d)
cat > profiles/rajni/data/lanes/linkedin/extract_resume.json <<EOF
{ "date": "$TODAY", "done": { "https://www.linkedin.com/jobs/search/?keywords=Staff+Frontend+Engineer&f_TPR=r86400&sortBy=R": 3 } }
EOF
```

Run `/farm` against it (see "the trap" below for interrupting before Chrome launches), watch
the log for the resume decision, then discard:

```bash
git checkout -- profiles/rajni/
rm -rf profiles/rajni/data/lanes profiles/rajni/data/runs
```

## The farm stage and Chrome — the trap

The LinkedIn lane owns Chrome's lifecycle end-to-end via the CDP browser adapter. If you run
`stage farm`/`run` for real, it launches the actual shared `.chrome-debug/` profile Chrome —
the same one `harish`/`uvashree` use for their live LinkedIn session. A SIGTERM sent right as
Chrome connects is **not fast enough** to reliably preempt the launch. Expect a real Chrome
window to spawn even when you kill within ~50ms of that point.

**Always check for and clean up afterward:**
```bash
ps aux | grep "remote-debugging-port=9222" | grep -v grep
# if found:
kill -TERM <pid>; sleep 3; kill -0 <pid> 2>/dev/null && kill -KILL <pid>
```

To test code that runs *before* the browser connects (e.g. resume/reset logic), poll the run's
log file (`profiles/<profile>/data/runs/<date>/*.log` — path from `RunFolder.logPath()`) for a
checkpoint just before the part you're testing, give it ~0.3s to let async writes land, then
SIGTERM.

## Fallback: throwaway profile for scenarios Rajni doesn't cover

For a genuinely novel one-off scenario Rajni's fixture doesn't model, create
`profiles/_verify_test/` instead (`node src/cli/main.ts profile build --profile _verify_test`
scaffolds a minimal `profile.json`/`filter.json`/`search_urls.md`/`avoid.md`), seed only the
files the stage under test actually needs, and `node src/cli/main.ts profile remove --profile
_verify_test --force` when done. Never run a test invocation against `profiles/harish/` or
`profiles/uvashree/` directly.

## A/B against unpatched code

`git stash` the fix (or `git checkout main -- <files>` if already committed), rerun the
identical scenario against Rajni, observe the (broken) before-behavior, restore the fix. This
is the strongest evidence that a fix actually causes the observed before/after difference, not
just that the after-state looks right in isolation.
