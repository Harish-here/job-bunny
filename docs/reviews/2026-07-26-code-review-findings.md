# Code review findings — 2026-07-26 (`HEAD~5..HEAD` on `main-v2`)

Scope: the five cutover commits `17ac29e..672f4d2` (JD-fallback fix + lane guard,
release-spine port + frozen Notion schema snapshot, v0 deletion, slash-command cut,
docs rewrite). Method: 8 independent finder angles (3 correctness, 3 cleanup,
altitude, conventions; Opus on correctness/altitude, Sonnet on cleanup/conventions),
deduped, then a 1-vote recall-biased verification pass per candidate. 24 distinct
candidates; 3 refuted; the 10 most severe survivors below, ranked. Verdicts:
**C** = confirmed from code (or live machine state), **P** = plausible.

## Findings (ranked most-severe first)

### 1. `npm run release 1.2.3 --dry-run` performs a REAL release — npm silently swallows the flags [C]
`package.json:19` (`"release": "node src/cli/main.ts release"`), documented in `CLAUDE.md`.
Without a `--` separator npm consumes `--dry-run`/`--no-merge`/`--yes` itself and forwards
only `1.2.3` (reproduced empirically with npm 10.8.2). `dryRun` arrives `false`, so the
plan-only invocation runs `npm version`, commits, pushes, and opens the release PR for real.
Fix: document/require `npm run release -- <ver> --dry-run`, or have `main.ts` refuse
`release` without an explicit `--dry-run`/`--yes`-style acknowledgement when invoked via npm.

### 2. `--no-merge` is silently ignored when resuming an already-open release PR [C]
`src/cli/commands/release.ts:600`. The only `if (NO_MERGE)` check lives inside the
`if (stage !== STAGE.AWAITING_MERGE)` block. Re-running `release X.Y.Z --no-merge`
after the PR exists resolves stage `AWAITING_MERGE`, skips the block, and proceeds to
`waitForChecks → confirmMerge → mergePr → tagFromMergedMain` — with `--yes` it merges,
deletes the branch, and tags despite the flag. Contradicts the option's own doc comment
("Stop right after opening (or finding) the release PR"). No test covers `noMerge`.
Fix: check `NO_MERGE` once, after `prNumber` is known, independent of stage.

### 3. `waitForChecks` can never detect a failing check — and a green PR with a SKIPPED check times out [C]
`src/cli/commands/release.ts:394,401`. `gh pr checks` exits non-zero when checks fail
(and 8 while pending); `runOk` returns `{ok:false, out:''}`, discarding the JSON stdout,
so the `if (out.ok)` gate skips the FAILURE/ERROR branch entirely — a red PR burns the
full 10-minute timeout and reports the misleading "checks still pending". Secondarily,
`checks.every(c => c.state === 'SUCCESS')` never becomes true when gh reports
SKIPPED/NEUTRAL/CANCELLED, so a mergeable PR also times out. The test fake always
returns `ok:true`, so neither path is covered.
Fix: parse stdout regardless of exit code (or use `--json` + jq semantics), and treat
SKIPPED/NEUTRAL as non-blocking.

### 4. The new lane-wide zero-capture guard throws away already-captured JDs on a resumed/second same-day fire [C]
`src/adapters/lanes/linkedin/lane.ts:576`. The guard tests this-invocation counters
(`totalCardsAttempted > 0 && totalCaptured === 0`) but the lane returns
`captureStore.all()`, which `CaptureStore.load()` seeds from prior same-day-fire
persisted captures (`capture_store.ts:37-40`). Concrete path: fire 1 captures N JDs and
marks its urls done; fire 2 skips them via `resumeState.shouldSkip`, attempts cards on
one url (all JD-opens fail) while another url's cards are all cache-hits
(`cardsAttempted === 0`, so `failedUrls < attemptedUrls` and the line-525 guard stays
quiet) — line 576 then throws, discarding the N valid JDs and every `DroppedRecord`
(the funnel loses its accounting too). The two behaviors are tested only in isolation.
Fix: compare against `captureStore.all().length`, or return an outcome instead of using
throw (the discard-everything channel) when real captured work coexists with the outage.

### 5. Five live v0 launchd agents are stranded by the `scripts/` deletion and the v2 pruner can never reap them [C — verified on this machine]
`src/adapters/scheduler/launchd/launchd.ts:42`. `~/Library/LaunchAgents` holds
`com.jobbunny.run.{0900,1130,1400,1630,1900}.plist`, each invoking the now-deleted
`/Users/harishamutha/Job-bunny/scripts/ops/run_scheduled.sh`. They fire M–F and die
instantly ("No such file"), with no notifier (the failure digest lived inside the
deleted script). v2's `LABEL_RE` `/^com\.jobbunny\.(\d{4})\.plist$/` cannot match the
`.run.` infix, so `jobbunny schedule install` never prunes them: the scheduled pipeline
is silently dead until manual `launchctl bootout` + reinstall. Related gap (P,
pre-existing): the v2 plist runs a bare `jobbunny` via `bash -lc`, and `which jobbunny`
resolves to nothing on this machine — a reinstall today would exit 127 with no digest.
Fix: widen the prune regex to legacy labels (one-time migration), and have
`doctor`/`schedule install` verify the plist's command actually resolves.

### 6. `openJd`'s `.catch(() => '')` swallows abort/CDP/JS errors and mislabels them as "extracted JD text was empty" [C]
`src/adapters/lanes/linkedin/jd_open.ts:130,137`. Both `page.evaluate(...).catch(() => '')`
calls are unconditional; pre-diff, evaluate errors propagated with their real message.
A `--run-cap-ms` abort or CDP "Target closed" now surfaces as the generic
`extracted JD text was empty (jdRoot …)` SoftError — exactly the string the lane's
`jdOpenFailures` evidence bucket samples and the new guard's message tells the operator
to blame on the jdRoot selector (`lane.ts:580`). Diagnostics for the 2026-07-25 class of
incident point at the wrong cause, and the card loop keeps grinding post-abort (only the
stage-level guard race terminates the run).
Fix: catch only "element yielded no text" shapes; rethrow abort/disconnect errors.

### 7. `'About the job'` is hardcoded in lane code while both committed inventories already carry `behaviors.jdAnchorText` [C]
`src/adapters/lanes/linkedin/jd_open.ts:54-58`. Both `page_inventory/linkedin__jobs-search.json`
and `linkedin__jobs-search-results.json` carry `"jdAnchorText": "About the job"` (line 23),
`InventorySchema` parses `behaviors` (`inventory.ts:23`), and `harvest.ts` already reads
`inv.behaviors.*` as the established pattern — yet the load-bearing anchor (now the
primary JD-text path, see #8) is a code constant. Violates CLAUDE.md: "Lanes are
config-driven, not code-driven… DOM drift is fixed by regenerating the inventory,
never by editing lane code." A LinkedIn copy/locale change kills every JD-open and the
only fix is a code PR. Compounding it, the fallback fires with zero observability
(only a debug log on the waitFor timeout): a run where 100% of JDs came via the anchor
is indistinguishable in `result.json` from a healthy one, so the broken `jdRoot` never
creates pressure to regenerate the inventory — until the anchor also drifts and the
lane goes from 100% green to 100% dead in one step.
Fix: read `inv.behaviors.jdAnchorText` (+ min-chars) with the current literals as
defaults, and count/warn per-card extraction source (`jdRoot` vs `anchor-fallback`).

### 8. Every card pays a guaranteed 15s dead `waitFor(jdRoot)` in the wired configuration [C]
`src/adapters/lanes/linkedin/jd_open.ts:114`. Both committed inventories are
`"pageType": "details-page"` with `"jdRoot": "#job-details"` — the direct-nav mode
CLAUDE.md's Known Limitations documents as never matching. The sole production caller
(`lane.ts:384`) passes no opts, so `waitForTimeoutMs` is always the 15s default: up to
`maxCardsPerUrl (40) × 15s ≈ 10 minutes of pure dead wait per url` before the anchor
fallback (a full-page `querySelectorAll('section, div, article, main')` + `innerText`
of every node + sort) runs per card. The wait predates the diff, but the diff converts
it from "timeout → fail card" into "timeout → continue", making it expected dead time.
Fix: drop/shorten the best-effort wait for details-page (the evaluates carry their own
timeouts), scope + short-circuit the anchor scan, hoist the constant anchor script.

### 9. Surviving onboarding docs still instruct invoking commands deleted in this same range [C]
`.claude/commands/setup.md:37-43` (edited in this range) tells the agent to run
`/add-url`, `/notify-setup`, `/doctor`, and `/run` — all four command files deleted in
the same diff, and CLAUDE.md itself now states "There is no /notify-setup".
`.claude/commands/page-analyse.md:35` (also edited here) gates on `/doctor` then `/run`.
`.env.example:5-11` still says chat_id is "written by /notify-setup" and points at
`scripts/setup/init.js`. Per CLAUDE.md, "Markdown is code here" — these are LLM
instructions, so `/setup` runs will chase nonexistent commands and skip Telegram wiring
and final verification.
Fix: rewrite the steps to the surviving forms (`jobbunny lane add-url`,
`jobbunny doctor`, `jobbunny run`, manual Telegram procedure per README).

### 10. `/structure` — one of the four surviving slash commands — still describes the v0 pipeline [C]
`.claude/commands/structure.md` (untouched by the cut) references `config.json`'s
`default_profile` fallback (file deleted in this range), `compress.js`/`assemble.js`,
and `structure_passthrough.json`, while v2's structure stage
(`src/pipeline/stages/structure.ts`) reads/writes storage-based
`structure/table.json` / `structure/passthrough.json` / `structure/decisions.json`.
Following the doc as written produces a table the v2 assemble stage will not parse.
Fix: rewrite `structure.md` against the v2 stage contract in the same spirit as the
other three surviving commands.

## Verified but cut by the 10-finding cap

- **[P]** `release.ts:536` — `readmeBadgeMatches` treats "badge regex absent" as
  "matches" (omits `.found`), the exact conflation `ReadmeBadgeResult`'s doc warns
  against; impact bounded to a wrong resume-stage label.
- **[P]** `release.ts:275-289` — `getPr` takes `arr[0]` of `--state all`; a stale
  CLOSED PR on a reused branch can dead-end a resumable release.
- **[P]** `release.ts:310,533` — resume path reads `origin/<branch>` refs that
  preflight never fetches (`fetch origin main` only); fresh clone/pruned repo fails
  with "invalid reference" on the advertised resume path.
- **[P]** `farm.ts:97` + `wire.ts` — LinkedIn is the only `FarmingLane`, so the new
  lane-wide throw always makes `failedLanes === farmingLanes.length` and aborts the
  whole 10-stage run at stage 2: healthy Greenhouse/Keka lanes never run that day.
  Consider whether "loud" must mean "abort", or "degraded run + digest".
- **[C]** `release.ts:235-262,291` — `run`/`runPorcelain`/`runOk` are three
  near-identical wrappers (collapsible to one), and the one-line `sleep` indirection
  has a single call site.
- **[C]** `release.ts:61` vs `:89` — `confirm`'s doc says "raw (untrimmed)" but the
  implementation trims.
- **[C]** `jd_open.test.ts:139` — the fake distinguishes evaluate scripts by
  source-text sniffing (`includes('querySelectorAll')`); branch on call order instead.
- **[P]** `release.ts:92` — uncancellable `setTimeout` sleep in a 10-minute poll loop
  (no AbortSignal anywhere in the command), against the repo's deadline posture.
- **[P]** `lane.ts:250-280` — six parallel scalar counters + four evidence buckets
  feed two guards; per-url stat records would derive both.

## Refuted during verification

- release.ts should reuse `CommandRunner` — the only one lives in
  `adapters/scheduler/launchd` and `only-wire-imports-adapters` forbids the import.
- release.ts violates the two-pair rule — `src/cli/commands/` (9 prior files, no
  `index.ts`, each a `main.ts` entry point) is the established repo-wide pattern.
- release's pure logic belongs in `core/` — sibling commands (`schedule.ts`,
  `run.ts`) keep command-local pure helpers the same way.
