# v2 Cutover Runbook

> Operational — follow this at 7am when a scheduled run has broken, or when actually
> executing cutover. Not an essay. Source: `docs/superpowers/plans/2026-07-21-v2-p8-cli-wiring-cutover.md`
> Task 7, root `CLAUDE.md`'s "Scheduling and notifications" / "Hard rules" sections.

## 1. Preconditions

Before touching any real profile or launchd job, all of the following must be true:

- [ ] `npm run check` green on `feat/v2-p8-surface` (or whatever branch cutover ships from).
- [ ] `jobbunny doctor --profile rajni` green (all findings non-`red`).
- [ ] **P8 Task 6 has run and passed.** As of 2026-07-25 it has **not**: it is blocked on
      the user providing a scratch Notion DB id + `NOTION_TOKEN` for `profiles/rajni/`
      (never a real profile DB). Until Task 6 has actually executed
      `jobbunny run --profile rajni` end-to-end against that scratch DB, cutover has zero
      evidence the P7 Notion adapter (`src/adapters/db/notion/`) can talk to the real
      Notion API — every test to date is stub-driven.
- [ ] Real profiles (`profiles/harish/`, `profiles/uvashree/`) have been migrated with
      `scripts-v2-migrate/migrate.ts --write` (§4) and `jobbunny doctor --profile <p>`
      is green for each.
- [ ] User has given explicit go for the specific step being executed — Task 7's plan
      requires this per bullet, not once for the whole cutover.

If Task 6 has not run, **do not cut over** — the honest state is "v2 has typechecked and
unit-tested its way to this point, but has never successfully written a Notion row."

## 2. The waived soak — record it honestly

The plan (`2026-07-21-v2-p8-cli-wiring-cutover.md`, Task 7) called for **≥3 consecutive
daily v0-vs-v2 dry-run diffs** reviewed before cutover: scheduled v0 runs as normal,
manual/parallel v2 runs with `--dry-run`, diffing v2's `sync_dryrun.json` (§3) against
v0's actual writes.

**This soak was waived by the user on 2026-07-25** ("don't worry about v0 runs"). It did
not happen — not once, not partially. Zero dry-run diffs have been reviewed.

Risk this leaves un-retired: v2's filter/dedup/rank stages
(`src/pipeline/stages/{filter,dedup,rank}.ts`) have never been run end-to-end against real
job data and compared to v0's known-good output. If there is a divergence — a filter rule
scoring differently, a dedup collision, a rank ordering difference — the first place it
will be visible is production Notion rows (wrong jobs appearing, right jobs missing,
duplicates), not a diff file. There is no dry-run evidence trail to fall back on if
something looks wrong post-cutover; the only signal will be the post-cutover watch list
(§7) and manual inspection of the Notion DB itself.

## 3. Dry-run procedure

Produce a v2 dry-run:

```bash
jobbunny run --profile <name> --dry-run
```

This writes `profiles/<name>/data/runs/<date>/sync_dryrun.json` (the sync stage
(`src/pipeline/stages/sync.ts`) never calls `connector.syncJobs` when `dryRunPath` is
set — it writes the would-write job set to that path instead). **The artifact records
which jobs would be written (their identities/fields going in), not the exact Notion
property payload sent over the wire** — it is not a substitute for inspecting a live
Notion row.

To compare against what v0 actually did, look at v0's real output on the same day:

- `profiles/<name>/data/new_jobs.json` — v0's `dedup.js`/`rank.js` final output, the set
  v0's `notion_sync.js` actually pushed to Notion that run.
- `profiles/<name>/data/cache.json` — v0's rebuildable Notion mirror
  (`scripts/notion/cache.js`); diff its state before/after the run to see exactly which
  rows v0 added.

Compare the job identity set (title+company+id) in `sync_dryrun.json` against the rows
`new_jobs.json` produced / `cache.json` gained that day. A mismatch (v2 would write a job
v0 didn't, or vice versa) is a real divergence — investigate before trusting v2's output
for that profile.

## 4. Migration

Dry run first, always:

```bash
node scripts-v2-migrate/migrate.ts --profile <name>
```

Review the printed diff and the `UNMAPPED v0 FIELDS` list. Only once satisfied:

**Before running `--write` on any real profile, take a manual backup — profile config
files under `profiles/harish/` (and `profiles/uvashree/`) are NOT git-tracked
(`profiles/` is entirely `.gitignore`d), so `--write` there is NOT git-recoverable.**

```bash
mkdir -p ~/jobbunny-backups
cp -a /Users/harishamutha/Job-bunny/profiles/harish "~/jobbunny-backups/harish-$(date +%Y%m%dT%H%M%S)"
```

(Repeat per profile being migrated — substitute `uvashree`, etc. Destination is outside
the repo tree on purpose.)

Then apply:

```bash
node scripts-v2-migrate/migrate.ts --profile <name> --write
```

`profile.json` is merged, never replaced (v0 and v2 key sets are disjoint); `filter.json`
is newly created; a company registry is created only if a boards file exists. The
migrator is idempotent — a second `--write` produces byte-identical output — so re-running
it after a partial failure is safe, but the backup above is still the only recovery path
if `--write` corrupts something the migrator's own idempotency check doesn't catch.

Verify after each profile:

```bash
jobbunny doctor --profile <name>
```

Must be green (no `red` finding — a `warn` doesn't block, per `doctorCommand`'s exit-code
rule) before that profile is considered migrated.

## 5. Cutover

Order of operations, once §1's preconditions are all met and the user has given explicit
go for this specific step (Task 7 requires per-bullet go, not a blanket one):

1. Confirm every profile being cut over has passed doctor (§4) and, ideally, Task 6's
   live-verify gate.
2. Install v2's launchd jobs — this is the one cross-profile v2 command (no `--profile`):

   ```bash
   jobbunny schedule install
   ```

   This enumerates every `profiles/<name>/profile.json`, collects one `ScheduledJob` per
   entry in `schedule.times[]` (honoring `schedule.enabled === false` as a skip, same as
   v0), and hands the whole set to the launchd `Scheduler` in one declarative reconcile.
   It prints one summary line per distinct time slot: `<label> | <time> | <profiles>`.

   **Label format differs from v0** — this is the detail that matters most for rollback
   verification:
   - v0 (`scripts/ops/schedule.js`): `com.jobbunny.run.<HHMM>` (e.g.
     `com.jobbunny.run.0700`).
   - v2 (`src/adapters/scheduler/launchd/plist.ts`, mirrored in
     `src/cli/commands/schedule.ts`): `com.jobbunny.<HHMM>` (no `.run.` segment — e.g.
     `com.jobbunny.0700`).

   Do not assume these are the same label — `jobbunny schedule install` does **not**
   remove v0's `com.jobbunny.run.*` jobs. This is confirmed at the code level, not
   inferred: v2's reconcile deletes stale plists by matching
   `LABEL_RE = /^com\.jobbunny\.(\d{4})\.plist$/`
   (`src/adapters/scheduler/launchd/launchd.ts:42`, used by `listPlistFiles`), and
   `com.jobbunny.run.0700.plist` does not match it — `run` is not `\d{4}`. **Left
   alone, v0 and v2 jobs both fire: the pipeline double-runs and the digest
   double-sends.** Step 3 is therefore mandatory, not optional cleanup. v0 stays untouched on disk for the ≥7-day soak
   (P9 gate) — its launchd jobs must be removed as a **separate, explicit** step (below),
   not assumed to be superseded automatically.
3. Remove v0's launchd jobs so both don't fire and double-run the pipeline / double-send
   digests. v0 has no documented single-profile `remove` CLI verb of its own for this —
   the safe path is unloading each `com.jobbunny.run.*` job directly:

   ```bash
   uid=$(id -u)
   for label in $(launchctl list | grep 'com\.jobbunny\.run\.' | awk '{print $3}'); do
     launchctl bootout "gui/$uid/$label"
   done
   rm -f ~/Library/LaunchAgents/com.jobbunny.run.*.plist
   ```

   UNVERIFIED: whether re-running `node scripts/ops/schedule.js` after clearing all
   profiles' `schedule.enabled` would achieve the same stale-job cleanup automatically
   (its own code does delete plists not in its `desiredLabels` set) — the manual
   `launchctl`/`rm` above is the path actually verified against the script's real label
   format and is safe regardless of profile config state.
4. Confirm only v2 jobs remain:

   ```bash
   launchctl list | grep com.jobbunny
   ```

   Expect to see only `com.jobbunny.<HHMM>` entries, no `com.jobbunny.run.<HHMM>` entries.

## 6. Rollback

If a scheduled v2 run has broken (bad digest, missing Notion rows, non-zero exit) and you
need to revert to v0 immediately:

1. Remove v2's launchd jobs:

   ```bash
   uid=$(id -u)
   for label in $(launchctl list | grep -E '^com\.jobbunny\.[0-9]{4}$' | awk '{print $3}'); do
     launchctl bootout "gui/$uid/$label"
   done
   ```

   (The regex excludes `com.jobbunny.run.*` on purpose — only bare `com.jobbunny.<HHMM>`
   v2 labels match.)

   `jobbunny schedule remove --profile <name>` also exists but is scoped to one profile
   at a time and delegates to the same `Scheduler.remove` — for a full rollback, the loop
   above (or repeating `schedule remove` per profile) both work; the loop is faster when
   every profile is being rolled back at once.

2. Reinstall v0's launchd jobs from `main` (the v0 tree, untouched throughout the soak):

   ```bash
   git -C /Users/harishamutha/Job-bunny status
   ```

   Confirm the working tree is clean or your changes are stashed, then:

   ```bash
   node scripts/ops/schedule.js
   ```

   This reads every profile's `schedule.times`/`schedule.time`, writes
   `~/Library/LaunchAgents/com.jobbunny.run.<HHMM>.plist` per distinct time, and
   bootstraps each with `launchctl`. Requires no branch switch if `scripts/ops/schedule.js`
   is present and unmodified on the current branch — it is v0 code, not touched by the v2
   work — but if in doubt, run it from a clean `main` checkout.

3. If any profile file was half-written by a v2 migration or run mid-incident, restore it
   from the backup taken in §4:

   ```bash
   cp -a "~/jobbunny-backups/<name>-<timestamp>/." /Users/harishamutha/Job-bunny/profiles/<name>/
   ```

   Use the most recent backup taken before the incident. There is no git history to fall
   back on for `profiles/` — the manual `cp -a` backup is the only recovery path.

4. Confirm rollback:

   ```bash
   launchctl list | grep com.jobbunny
   ```

   Expect only `com.jobbunny.run.<HHMM>` entries (v0), zero bare `com.jobbunny.<HHMM>`
   entries (v2). Then wait for (or manually trigger) the next v0 scheduled run and check
   `profiles/<name>/data/last_run_result.json` and the Telegram digest arrive as normal.

## 7. Post-cutover watch list

After the **first** scheduled v2 run per profile, check all of the following before
trusting the schedule unattended:

- **Exit code.** v2's `run` command returns `0` on `passed`, `1` on `failed` — same
  convention as v0's `orchestrate.js`. Check the launchd job's stdout/stderr log at
  `~/Library/Logs/JobBunny/<label>.{out,err}.log` — same log directory convention as v0,
  confirmed in `src/adapters/scheduler/launchd/plist.ts` (`StandardOutPath`/
  `StandardErrorPath` built from `${home}/Library/Logs/JobBunny/${label}.{out,err}.log`).
- **Result record.** v2's equivalent of v0's `last_run_result.json` is
  `profiles/<name>/data/runs/<date>/result.json`, written by `RunFolder.writeResult()`
  (`src/ops/observability/run_folder.ts`) — schema is `RunResultSchema`
  (`src/ops/observability/result.ts`): `outcome` (`passed`/`failed`), `failedStage` if
  failed, and a per-stage `jobsIn`/`jobsOut`/`dropsByRule` funnel. Check `outcome` first,
  then walk the funnel for a stage where `jobsOut` collapsed unexpectedly.
- **Telegram digest.** Confirm it arrived in the expected chat. v2's digest text
  (`src/ops/observability/digest.ts`) mirrors v0's format (banner, separator, per-stage
  funnel lines, ✅/🔴 icon) but is built directly from `RunResult` rather than
  markdown-table-parsed — a formatting difference here is expected and not itself a bug.
- **Notion row count sanity.** Open the profile's live Notion DB and confirm the row
  count grew by roughly the number the digest/`result.json` funnel claims for the `sync`
  stage's `jobsOut`. No dry-run diff history exists to compare against (§2) — this manual
  check is the only safety net for the first several real runs.
- **No double-fire.** Confirm exactly one `com.jobbunny.<HHMM>` job exists per time slot
  (not also a lingering `com.jobbunny.run.<HHMM>` from an incomplete cutover) — a
  double-fire would double-insert rows since `sync`'s stage now ships `retries: 0`.
