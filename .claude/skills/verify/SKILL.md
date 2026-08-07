---
name: verify
description: Repo-specific recipe for driving Job Bunny's v2 pipeline stages at runtime instead of only unit-testing them.
---

# Verifying Job Bunny changes

v2 stages are driven through the `jobbunny` CLI, always under Node 24 (the machine default; `.nvmrc` pins the repo — if `node -v` ever shows < 24, run `source ~/.nvm/nvm.sh && nvm use 24`):

```bash
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

Every `stage <name>` run continues in TODAY's latest existing group (a `(run_date, time_dir)`
pair in `profiles/rajni/data/jobbunny.db`'s `checkpoints`/`runs` tables — persist-to-db Phase 2;
creating a fresh group only when today has none yet), resumes from the latest checkpoint row in
that group (falling back to `{ jobs: [], dropped: [] }` if there is none yet), and writes a new
checkpoint row at that stage's own slot — `dedup` needs `reconcile` to have run first this same
day (it reads the `cache/entries.json` key via `ctx.stateStore`, a `state_docs` row now — persist-to-db
Phase 3 — not a checkpoint, and not a file either). No files are written under
`profiles/rajni/data/runs/` anymore — that folder tree is retired. If a stage run ever leaves
`profiles/rajni/`'s *committed* files dirty, restore them with:

```bash
git checkout -- profiles/rajni/
```

Per-run intermediates now live entirely inside `data/jobbunny.db*` (already gitignored) — the
`checkpoints`/`runs`/`run_events`/`state_docs` tables replace what used to be
`data/registry/`, `data/lanes/`, and `data/cache.json` on disk (persist-to-db Phase 3; those
directories/files are legacy-lift sources only, read once if present, never written again). A
stray run leaves no other files to clean up. To reset checkpoint/run/state history between
fixture experiments (e.g. to force a fresh group instead of continuing today's chain, or to
force a fresh legacy-file lift), delete the db file itself: `rm -f profiles/rajni/data/jobbunny.db*`
(the `-wal`/`-shm` sidecars included) — the next stage run recreates it fresh via the migrations.

### Editing rajni's config for an experiment

`profile.json`/`filter.json`/`resume.json`/`search_urls.md` are config→db Phase 4 config docs
now, not plain files: `profiles/rajni/data/jobbunny.db`'s `config_docs` table wins once any stage
run has lifted them (any prior stage/run invocation against rajni does this). Hand-editing the
tracked file under `profiles/rajni/` after that point is a **silent no-op** — every reader hits
the DB row, not the file, and nothing re-checks the file once its row exists. To actually change
a doc for an experiment, either:

```bash
# Edit the doc, then write it back through the store (stdin pipe, TTY refused):
node src/cli/main.ts config get filter.json --profile rajni > /tmp/rajni-filter.json
# ...edit /tmp/rajni-filter.json...
node src/cli/main.ts config set filter.json --profile rajni < /tmp/rajni-filter.json
```

or, to go back to the tracked fixture's pristine config rather than a hand-edited variant, force
a fresh lift: `rm -f profiles/rajni/data/jobbunny.db*` re-lifts straight from the tracked files on
the next read (the tracked files under `profiles/rajni/` remain the lift SOURCE — they are never
themselves written by any of this). `git checkout -- profiles/rajni/` still restores those
tracked files if a stage run or hand-edit left one of them dirty — separate from, and in addition
to, the db-file reset above.

### The LinkedIn lane's resume/state logic

The lane persists per-URL same-day completion via the `StateStore` port at the key
`lanes/linkedin/extract_resume.json` — shape `{ date, done: { <url>: <count> } }`
(`src/adapters/lanes/linkedin/resume_state.ts`). Since persist-to-db Phase 3 this is a row in
`profiles/rajni/data/jobbunny.db`'s `state_docs` table (`key`/`value_json`/`updated_at`), not a
file — `SqliteStateStore.readDoc` only ever lifts the legacy file (if one exists) into that row
ONCE, on the first read after a fresh DB; every later read hits the DB row directly and never
looks at the file again, so re-heredocing the old file is a silent no-op against an
already-lifted DB. Seed the row directly instead — a stale (non-today) `date` or a missing row
starts fresh, so this seed is never committed:

```bash
TODAY=$(date +%Y-%m-%d)
sqlite3 profiles/rajni/data/jobbunny.db \
  "INSERT OR REPLACE INTO state_docs (key, value_json, updated_at) VALUES (
     'lanes/linkedin/extract_resume.json',
     '{\"date\":\"$TODAY\",\"done\":{\"https://www.linkedin.com/jobs/search/?keywords=Staff+Frontend+Engineer&f_TPR=r86400&sortBy=R\":3}}',
     datetime('now')
   );"
```

(If you'd rather exercise the legacy-file lift path itself: `rm -f profiles/rajni/data/jobbunny.db*`
first to force a fresh DB, THEN heredoc the file at `profiles/rajni/data/lanes/linkedin/extract_resume.json`
in the old `{ date, done }` shape — the first read after that lifts it into `state_docs` once.
Note this also wipes checkpoint/run history for the fixture, since it's the same db file.)

Run `/farm` against it (see "the trap" below for interrupting before Chrome launches), watch
the log for the resume decision, then discard:

```bash
git checkout -- profiles/rajni/
rm -f profiles/rajni/data/jobbunny.db*
rm -rf profiles/rajni/data/lanes
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
events instead — run observability now lives in the profile's local sqlite DB, not a `run.log`
file: `node src/cli/main.ts runs --profile rajni show <id>` (or query `run_events` directly via
`sqlite3 profiles/rajni/data/jobbunny.db`) — for a checkpoint just before the part you're
testing, give it ~0.3s to let the buffered `RunStoreLogger` flush land, then SIGTERM.

## Fallback: throwaway profile for scenarios Rajni doesn't cover

For a genuinely novel one-off scenario Rajni's fixture doesn't model, create
`profiles/_verify_test/` instead (`node src/cli/main.ts profile build --profile _verify_test`
scaffolds a minimal `profile.json`/`filter.json`/`search_urls.md` config doc set — `avoid.md`
is no longer seeded, config→db Phase 4 dropped that dead surface), seed only the config docs the
stage under test actually needs (`node src/cli/main.ts config set <doc> --profile _verify_test`,
piped), and `node src/cli/main.ts profile remove --profile _verify_test --force` when done. Never
run a test invocation against `profiles/harish/` or `profiles/uvashree/` directly.

## A/B against unpatched code

`git stash` the fix (or `git checkout main -- <files>` if already committed), rerun the
identical scenario against Rajni, observe the (broken) before-behavior, restore the fix. This
is the strongest evidence that a fix actually causes the observed before/after difference, not
just that the after-state looks right in isolation.
