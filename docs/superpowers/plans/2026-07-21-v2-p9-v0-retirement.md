# v2 P9 — v0 Retirement + Docs Ground-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (mostly mechanical; review gates are the deletion inventory and the two rewritten docs).
> **Depends on:** P8 cutover complete. TWO DISTINCT SOAK GATES, do not conflate them: (a) the ≥3-day v0-vs-v2 PARITY soak — running both pipelines in parallel and diffing their output — was WAIVED by the user 2026-07-25 and will not happen; (b) the ≥7-day green-scheduled-v2-run soak still STANDS and gates Task 2 (deleting v0) only, not the rest of P9. Waiving (a) makes (b) more important, not less: with no parity diff, green v2 runs are the only remaining evidence before the reference implementation is destroyed. Check `main-v2.md` soak start date + `last_run_result`/`result.json` history. Do not start early.

**Goal:** Delete v0 completely, rewrite CLAUDE.md and README.md from scratch for v2, prune branches, make `main-v2` the new `main`.

## Global Constraints

- Branch `chore/v2-retire-v0` off `main-v2`.
- **Deletion is by explicit inventory** (below) — nothing outside it; anything unexpected found during deletion gets surfaced, not silently removed.
- CLAUDE.md and README.md are **rewrites from scratch** (open a blank file), not edits — decision 24.
- Every step keeps `npm run check` green.

---

### Task 1: Soak gate check
- [ ] Verify ≥7 daily v2 runs since cutover, all `outcome: passed` (or failures explained + fixed). This gates Task 2 (deleting v0) specifically — items 1-7 of the closure register below can and should proceed before the soak completes. If the soak is not yet ≥7 days, only Task 2 waits.

### Task 2: Delete v0 code (the inventory)
- [ ] Delete: `scripts/` (entire tree — includes `scripts/ops/release.js`: port it to `src/cli/commands/release.ts` FIRST if `/wrap ship` is still wanted, decide with user), `scripts-v2-migrate/`, v0 launchd plists (`jobbunny schedule install` already replaced them — verify with `launchctl list | grep jobbunny` before deleting anything).
- [ ] Delete the 16 replaced commands from `.claude/commands/` (and skill mirrors): run, doctor, reconcile, cleanup, schedule, notify-setup, add-url, update-resume, remove-profile, extract, greenhouse, keka, filter, dedup, rank, sync. **Keep:** setup, page-analyse, structure, wrap, verify — rewrite each against v2 (wrap `jobbunny` commands / v2 paths).
- [ ] Delete per-profile v0 files after confirming migrator output is live: `filter_config.json`, `avoid.md`, `greenhouse_boards.md`, `keka_boards.md`, `resume_meta.json` (and `npm run meta` path). `search_urls.md` **stays** (still the lane's URL source). `page_inventory/*.md` deleted only where superseded by `<page>.json`.
- [ ] package.json: remove v0 scripts (`init|meta|reconcile|filter|dedup|rank|sync|release` as ported), remove `dotenv` dependency, verify `npm run check` green with `test: node --test src/`.

### Task 3: Rewrite CLAUDE.md from scratch
STATUS 2026-07-25: deliberately DEFERRED until after cutover — rewriting CLAUDE.md as v2-only while v0 is still the scheduled production pipeline would make the doc describe a system that isn't running.
- [ ] Blank-file rewrite for v2 only: what Job Bunny is; commands (`jobbunny …`, `npm run check`); pointer to `main-v2.md` decision log + module contracts as the architecture source; the surviving hard rules restated for v2 (byte-exact Notion options, token-economy structure path, deadline-bound CDP, fail-soft taxonomy, seed-never-clobber, core purity + two-pair rule); profile layout; verify-on-rajni rule; PR gate. Keep it as tight as the v0 one — markdown is code.

### Task 4: Rewrite README.md from scratch
STATUS 2026-07-25: deliberately DEFERRED until after cutover, same reasoning as Task 3.
- [ ] Blank-file rewrite: what it is, install (Node 24, `npm ci`, `npx playwright install chromium`? — no: real Chrome via CDP, say so), `/setup` onboarding, `jobbunny` usage, scheduling, architecture one-pager linking the spec.

### Task 5: Branch + repo hygiene
- [ ] Delete merged/stale branches (list at execution time via `git branch --merged`; confirm each unmerged one with user before deletion).
- [ ] Make v2 the default: PR `main-v2` → `main` (or repoint default branch to `main-v2` then rename — pick with user based on protection rules), tag `v2.0.0` on merged HEAD via the release flow.
- [ ] Update `main-v2.md`: P9 ✅ — project complete; the file itself stays as the architecture decision record.

## Fetch-time gate parity (added 2026-07-25) — ✅ RESOLVED 2026-07-25, see P9 item 1 below

- CORE FACT: On 2026-07-25 a real `stage source` run for profile harish emitted 3275 jobs into the LLM `structure` stage, which blew its 30-minute timeout. v0's ceiling is ~80 new ATS jobs per run (`GH_MAX_NEW`, `KEKA_MAX_NEW`, both default 40 — `scripts/pipeline/greenhouse.js:155`, `scripts/pipeline/keka.js:211`, enforced `scripts/pipeline/ats_common.js:267-271`).
- ROOT CAUSE: v2 applies avoid/title rules only in the `filter` stage, which runs AFTER `structure` (`src/cli/wire.ts:580-591` — `source`:583, `structure`:585, `filter`:587). v0 applies the same logic at fetch time, before the LLM.
- GAP A — ATS source stage (`src/pipeline/stages/source.ts`), the 3275-job flood. Missing vs v0's `ats_common.js` per-job loop: card-altitude avoid+title gate (`ats_common.js:259-266`); `seen` ledger gate (`ats_common.js:251`); `maxNew` emitted-job cap (`ats_common.js:267-271`). `makeSourceStage`'s only limits are `maxProbesPerRun` (caps BOARDS probed, `source.ts:152`) and `laneBudgetMs` (wall-clock) — neither caps emitted jobs. The Notion-cache gate added 2026-07-25 (`ca6d054`) is NOT the fix: it suppressed 12 of 3275 (0.37%) because the profile's Notion cache holds only 46 entries.
- GAP B — LinkedIn lane (`src/adapters/lanes/linkedin/`). The card-level title/avoid gate ALREADY EXISTS and works: `lane.ts:165` calls `gateCards(cards, this.filterCfg)` → `evaluateCard` (`harvest.ts:228`) on raw card title+company BEFORE `jd_open.ts` opens any detail pane, emitting real DroppedRecords. DO NOT re-implement it. Missing vs v0's `applyCardGates` (`scripts/pipeline/extract/filters.js`): cache-skip against known Notion job ids (`filters.js:46`); cross-URL run-dedup on job id (`filters.js:57`, v2 tracks only a `companiesSeen` set at `lane.ts:173`); per-URL card cap (v0 `CARD_CAP` from `EXTRACT_MAX_CARDS`, `extract.js:66`). Each missing gate costs a real page-open: goto 30s / click 15s / waitFor 15s / evaluate 10s (`jd_open.ts:34-37`).
- MECHANISM ALREADY EXISTS — wiring, not new logic. `src/core/filter/engine.ts:26` exports `evaluateCard(card: CardInput, cfg: FilterConfig): Verdict[]`; `CardInput` (`src/core/filter/rules/types.ts:4-8`) is `{ title: string; company: string; location?: string }` — plain strings, nothing from the LLM stage. v2 encodes v0's `{ only: ["title"] }` subsetting structurally: card-runnable rules define `evalCard` (`title.ts:45`, `company.ts:25`); rules needing structured data omit it (`types.ts:15-17`).
- DESIGN NOTE: the title gate is the workhorse, not the cache gate. A v0 title fails on a blocked function term, OR no seniority match, OR no domain match (`scripts/pipeline/title_filter.js:32-55`). A bare `maxNew` cap WITHOUT the title gate yields N arbitrary jobs rather than the N most relevant. Gate first, measure what survives, add a cap only if the number is still unreasonable — a silent truncation cap hides problems.
- CROSS-REFERENCE: satisfies the CLAUDE.md constraint that avoid-list companies must drop on card data before JDs open.

## P9 = final closure — complete open-item register (compiled 2026-07-25)

P9 is the last packet. Nothing may be carried past it. Each item below states the fix and the test that proves it. Items marked BLOCKING must be closed before the launchd cutover; items marked NON-BLOCKING may land in P9 but do not gate the cutover.

### 1. ✅ Fetch-time gate parity (RESOLVED 2026-07-25)

Cross-reference the existing "Fetch-time gate parity" section above; do not duplicate its detail. Summarised as three ATS sub-items and three LinkedIn sub-items:

- ATS `src/pipeline/stages/source.ts`: wire `evaluateCard` gate; add `seen` ledger; add `maxNew` cap.
  TESTS: a job whose card fails the title rule is never emitted; a job whose company is on the avoid list is never emitted; both emit DroppedRecords with the right rule strings (`title.domain`/`title.function`/`title.seniority`, `company.avoid`); the cap truncates deterministically and logs once; a replay test asserting the harish fixture emits a two-digit number of jobs, not ~3275.
- LinkedIn `src/adapters/lanes/linkedin/`: cache-skip vs known Notion ids; cross-URL run-dedup on job id; per-URL card cap.
  TESTS: a card whose id is in the cache never reaches `jd_open`; the same job id appearing under two URLs opens exactly once; the cap bounds page-opens per URL.

RESOLVED 2026-07-25. `evaluateCard` title/avoid gate now runs at fetch time in `src/pipeline/stages/source.ts` before anything reaches `structure`; job-level seen ledger at `registry/api_seen.json`; `maxNewPerLane` cap (default 40, matching v0's GH_MAX_NEW/KEKA_MAX_NEW) — ATS hard ceiling now 80 (2 lanes x 40) vs the 3287 that blew the structure timeout. LinkedIn: Notion-cache skip, cross-URL run-dedup on job id, per-URL card cap (`maxCardsPerUrl`, default 40) — reusing the existing `gateCards`, not reimplementing it. Caps emit DroppedRecords and log loudly when they fire.
DELIBERATE PARITY DIVERGENCES from v0 (decisions, not defects): (a) gate order is title/avoid FIRST, then seen/cache, then cap — v0 did seen → cache → avoid → title; changed to cheapest-first on purpose. (b) no stale-seen pruning: v0 pruned seen entries once they left the live board, `api_seen.json` only grows.
OPEN RISK (unresolved): LinkedIn's ceiling is per-URL, so a profile with ~21 search URLs still permits ~840 cards. The title gate should cut this hard in practice but the real number is unmeasured until a live run.

### 2. Silent-failure guards (BLOCKING) — RESOLVED 2026-07-25 except the farm 0-job diagnosis (still OPEN, see below)

- `src/pipeline/stages/farm.ts` reports `outcome: passed` when EVERY farming lane throws — it catches a whole-lane failure as `ctx.logger.warn('farming lane failed entirely', ...)` and continues. A total LinkedIn outage currently looks like a clean run. This is the same class of defect as the zero-card harvest already fixed in `68a2e9b`.
  FIX: fail the stage when all lanes fail (distinguish "some lanes degraded" from "everything died").
  TEST: all-lanes-throw produces a failed run; one-of-two-lanes-throws still passes with a warn.
- Diagnose why `farm` harvested 0 jobs in 227s on the 2026-07-25 run. Unknown whether stale login, further selector drift, or the new harvest readiness gate (`68a2e9b`) correctly refusing a bad page. MUST be diagnosed against live Chrome before another full run is spent.
  TEST: an authenticated live harvest yields a non-zero card count through the adapter (not via a standalone script — the 2026-07-25 CDP bug was missed precisely because the verify script exercised a different code path than the pipeline).
- **BLOCKING — `src/pipeline/stages/source.ts:249-255` has the IDENTICAL defect to farm.ts, in a different file.** A total failure of ALL API lanes is caught as `ctx.logger.warn('api lane failed entirely', ...)` and the run reports `passed`. Greenhouse and Keka can both die and source emits 0 jobs with a clean outcome. Note: the LinkedIn lane DOES guard this correctly (`src/adapters/lanes/linkedin/lane.ts:225-231` throws when all URLs fail) — that guard exists nowhere else. FIX: apply the same all-lanes-failed throw in source.ts and farm.ts. TEST: all-lanes-throw fails the stage; one-of-two-throws passes with a warn.
- IMPORTANT — `src/adapters/lanes/greenhouse/lane.ts:162-166` and `src/adapters/lanes/keka/lane.ts:177-181`: a job dropped for failing `JDSchema` is logged as a warn but emits **no DroppedRecord**, so the funnel does not account for it. An upstream schema drift that zeroes an ATS lane looks like a clean run. FIX: emit DroppedRecords. TEST: a schema-invalid job appears in the funnel's dropped set.
- IMPORTANT — `src/adapters/lanes/linkedin/lane.ts:192-197` + `:210-213`: a URL where EVERY card's JD-open fails is still `markDone(url, 0)`, so it is skipped for the rest of the day; per-card failures emit no DroppedRecord either. FIX: do not mark a URL done when its capture count is zero and failures occurred. TEST: all-cards-fail leaves the URL resumable.
- IMPORTANT — `src/adapters/db/notion/archive.ts:120-124`: dropped archive pages emit no DroppedRecord, unlike its sibling `sync.ts:92`. FIX: match sync's behaviour. TEST: a failed archive appears in the funnel.

RESOLVED 2026-07-25. `farm.ts` and `source.ts` now throw when EVERY lane fails (partial failure stays fail-soft, unaffected). DroppedRecords now emitted for greenhouse/keka JDSchema drops, linkedin all-cards-failed URLs, and notion archive failures. Ports widened to return `{ jobs, dropped }` (`ApiLane.fetchBoard`) and `{ archived, dropped }` (`Connector.archiveStale`) so collectors cannot go unfed.
REMAINING GAP: cleanup routine drops are logged but do NOT reach `RunResult`'s funnel — routines run outside `runPipeline`, `Routine.run` returns void. Widening `Routine` is a follow-up.
STILL OPEN — NOT diagnosed: the 0-jobs-in-227s `farm` harvest from 2026-07-25 remains unexplained (stale login vs. selector drift vs. the harvest readiness gate correctly refusing a bad page). Must be diagnosed against live Chrome before another full run is spent.

### 3. ✅ Browser lifecycle (RESOLVED 2026-07-25)

- `CdpChromeProvider` kills Chrome on exit even for an instance it merely REUSED rather than launched (unless `JOBBUNNY_KEEP_BROWSER=1`). This took down a logged-in user browser mid-session on 2026-07-25.
  FIX: only kill what this process launched; track launched-vs-reused.
  TEST: reused instance survives provider disposal; launched instance is killed.

RESOLVED 2026-07-25. `CdpChromeBrowserHandle` now tracks `ownsProcess`; `close()` is a no-op for a reused Chrome, kills for launch and for recycle-respawn. `JOBBUNNY_KEEP_BROWSER=1` still overrides all cases.

### 4. ✅ Test-suite reliability (RESOLVED)

- RESOLVED 2026-07-25 (`1a0ccf9`). CORRECTION: the bound was **500ms**, not 20ms — the assertion's message string reads "near 20ms cap" while the actual bound was `elapsed < 500`, which is what earlier notes misreported. Raised to 2000ms with a comment; still fails if a real multi-second wait or retry backoff is introduced. Verified 5/5 consecutive runs and `npm run check` green at 1172 tests.

### 5. Correctness carry-forwards from P6/P7 (NON-BLOCKING unless noted) — CLOSED 2026-07-25 except where noted OPEN below

- CORRECTED 2026-07-25 (was stale): `retries` is **0** today, not 1 — that earlier figure was wrong. But this is LOAD-BEARING, not incidental: an investigation this session traced `syncJobs` (`src/adapters/db/notion/sync.ts`) and confirmed the underlying hazard is REAL — `syncJobs` decides insert-vs-update purely from `job.sync?.pageId` on its INPUT and never re-queries Notion for an existing page, so a FUTURE stage-level retry would re-invoke over the original input array and re-`createPage` jobs that already succeeded. Per-job failures are `SoftError`s caught inline and never trigger this today. Sync must not be given `retries` above 0 until `syncJobs` is made idempotent. TEST (still to write): a hard failure mid-batch followed by a retry inserts each job exactly once.
- CLOSED 2026-07-25: `dedup`'s cache index no longer overwrites city variants — a bucket-of-candidates now uses the existing `citiesConflict` predicate so entries differing only by city are retained and matched independently.
- CLOSED 2026-07-25: `compress` now emits a `compress.duplicate-id` DroppedRecord instead of a silent last-wins collapse.
- STILL OPEN (untouched, decision only): `dedup` runs AFTER `structure` in the stage order (`src/cli/wire.ts:580-591`), so the LLM pays for jobs that are about to be deduped. Decide whether to reorder. TEST: if reordered, a known-duplicate never reaches the LLM stage.
- STILL OPEN (untouched, decision only): `rank`'s YoE axis is neutral-defaulted because no YoE field exists on `StructuredJD`; real score ceiling is 95, nominal 100. Decide: add the field or document the ceiling permanently.
- depcruise `includeOnly: '^src'` means the src→scripts boundary is NOT mechanically enforced. After `scripts/` is deleted this becomes moot — confirm at deletion time rather than fixing now.

### 6. Never-verified paths (BLOCKING) — STILL OPEN as of 2026-07-25

- No v2 run has EVER completed end to end. This is the headline risk: a filter/dedup/rank divergence would first surface as wrong rows in production Notion. The ≥3-day v0-vs-v2 parity soak was WAIVED by the user 2026-07-25.
  TEST: one full `jobbunny run --profile <p> --dry-run` completing with non-zero counts through farm -> source -> structure -> sync, followed by one non-dry run reviewed row-by-row against expectations.
- P7 Notion adapter WRITE path has never spoken to the real API (`reconcile`'s read path was exercised 2026-07-25, 46 entries). The specific risk: a byte-exact select option string that live Notion rejects in practice (`scripts/notion/schema.js`).
  TEST: a real insert + a real anchored update against a SCRATCH Notion DB — never a real profile DB.
- P8 Task 6 (rajni full-pipeline verify) is BLOCKED on a scratch Notion DB id; rajni's `notion_db_id` is empty so the migrator emits `settings.notion.dbId: ""`.
  ACTION: obtain a throwaway Notion database id + `NOTION_TOKEN`.
  STATUS 2026-07-25: still BLOCKED on the scratch Notion DB id — no v2 run has ever completed end to end and the Notion WRITE path has never spoken to the real API.

### 7. Cutover mechanics (BLOCKING) — NOT STARTED as of 2026-07-25

- STATUS 2026-07-25: unchanged — `jobbunny schedule install` has NOT been run; v0's `com.jobbunny.run.*` launchd jobs have NOT been removed. v0 remains the scheduled pipeline. Per the cutover runbook section 5 step 3, removal is explicit, not implicit.
  TEST: after cutover, exactly one scheduler is installed; `launchctl list` shows the v2 jobs and none of the v0 jobs; a scheduled fire produces a run folder and a Telegram digest.
- Wiring constraint to re-verify at cutover: pipeline `stallMs` MUST exceed the structure provider's per-call `timeoutMs` (structure only beats between batches, so a tighter stall watchdog false-kills a live batch).
- The migrator leaves `avoid.md`'s alias map unmapped (v2 has no per-profile alias map). Decide: implement or accept the loss explicitly.

### 8. v0 retirement proper — STILL DEFERRED as of 2026-07-25

- Delete `scripts/`, retire the v0 slash commands, rewrite docs ground-up (see locked decision 24 in `main-v2.md`).
  GATE: do this LAST, only after items 1-7 are closed and v2 has run clean in production for a period you nominate. Deleting `scripts/` destroys the reference implementation every parity question in this document is answered against.
  STATUS 2026-07-25: gated on the user's >=7-day green-scheduled-run soak (Task 1 above), not yet met — items 6 and 7 are also still open, so this deletion has not started.

### 9. ✅ Run orchestration + preflight (RESOLVED 2026-07-25, all six items)

- **BLOCKING — no doctor preflight in the run path.** v0's invariant is that `doctor` is the FIRST pipeline stage and a red result ABORTS the run (CLAUDE.md pipeline table). v2 has no doctor stage in the list (`src/cli/wire.ts:580-591` starts at `reconcile`) and `runCommand` never evaluates the `checks` array it receives from `wire()` (`src/cli/commands/run.ts:110-116`). A run therefore proceeds with a dead browser, an expired login or a missing `NOTION_TOKEN` and fails deep in the pipeline instead of immediately. FIX: evaluate `checks` before the first stage and abort on red. TEST: a red check aborts before `reconcile` runs; an amber check warns and proceeds.
  RESOLVED: doctor preflight now runs in `runCommand` via `runChecks`; a `red` finding aborts before any stage.
- **BLOCKING — the run cap is smaller than the work.** `DEFAULT_RUN_CAP_MS = 1_800_000` (`src/cli/commands/run.ts:67`) EQUALS a single stage's timeout — farm (`farm.ts:19`) and structure (`structure.ts:46`) are each 1_800_000 — while the sum of all stage timeouts is ~68 minutes. The cap will abort legitimate runs. Note this is a DIFFERENT constraint from the already-registered `stallMs` > structure-provider-`timeoutMs` rule; both must hold. FIX: derive the run cap from the stage budget rather than pinning it to one stage's value. TEST: a run whose stages legitimately sum past 30 min is not aborted.
  RESOLVED: run cap is now DERIVED — `computeRunCapMs` = sum(timeoutMs x (retries+1)) x 1.25, ~141 min, so it cannot silently drift from stage budgets again. New `--run-cap-ms` operator override.
- **BLOCKING — no sequential multi-profile guard.** v0's `run_scheduled.sh` ran profiles STRICTLY sequentially because they share one Chrome/CDP session and one `.chrome-debug/` user-data-dir. v2's `src/cli/commands/schedule.ts` + `src/adapters/scheduler/launchd/plist.ts` install one launchd job per distinct time with nothing serialising two profiles that fire at the same time. FIX: a cross-profile lock or a single scheduled entry point that iterates profiles. TEST: two profiles scheduled at the same time execute one after the other, never concurrently.
  RESOLVED: cross-slot overlap now prevented by a repo-global exclusive file lock (`src/ops/scheduling/run_lock.ts`, `.jobbunny-run.lock`), stale-detected by pid liveness + 4h age fallback, SKIP not wait. Note: same-time-slot serialization was ALREADY correct via `plist.ts` chaining profiles with `;` — only cross-slot was broken.
- **BLOCKING — a notifier failure fails a passed run.** `src/adapters/notify/telegram/telegram.ts:36-38` throws at SEND time when `TELEGRAM_BOT_TOKEN` is missing; combined with `src/cli/wire.ts:559-561` (`Promise.all` over notifier sends) and `src/cli/commands/run.ts:121-125`, that throw escapes `runCommand` AFTER the pipeline already passed, so `src/cli/main.ts:232` returns exit 1 and the funnel summary is never printed. Separately, the `fetch` at `telegram.ts:41` has NO timeout or AbortSignal, so an unresponsive Telegram hangs the process past the run cap. FIX: make digest delivery best-effort and never able to change a run's exit code; add a timeout to the fetch. TEST: a throwing notifier leaves exit code 0 and still prints the summary; a hanging notifier is abandoned after its timeout.
  RESOLVED: notifier failures no longer change a run's exit code (`Promise.allSettled` in `wire.ts`); Telegram fetch got a 10s AbortSignal.
- **BLOCKING — `sync` cannot finish a real write volume.** `src/pipeline/stages/sync.ts:55-56` is `timeoutMs: 180_000, retries: 0`. At Notion's rate limits with backoff this will not cover a realistic insert set, and a timeout mid-sync fails the stage with rows already written. Interacts with the registered sync-retry-idempotency item — fix them together. TEST: a sync of a realistic batch completes inside the budget, and a mid-sync timeout does not double-write on the next run.
  RESOLVED: sync timeout raised 180s → 900s; `retries: 0` deliberately preserved (see the CORRECTED item 5 entry — retries stays at 0 until `syncJobs` is idempotent).
- IMPORTANT — `src/pipeline/stages/structure.ts:156` sets `retries: 1` on a 30-minute stage running under a 30-minute run cap; the second attempt can never complete. FIX: drop to 0 or raise the cap. TEST: a failing structure stage does not consume the entire cap retrying.
  RESOLVED: structure `retries: 1` KEPT — each attempt gets a fresh timeout (verified in `guard.ts`); the real defect was the run cap, fixed above at that layer.
- IMPORTANT — `filter`/`dedup`/`rank`/`assemble`/`compress` all use a 30s timeout with `retries: 0` (`filter.ts:30`, `dedup.ts:36`, `rank.ts:23`, `assemble.ts:141`, `compress.ts:80`) and have never been exercised at the observed 3275-job volume. TEST: each completes inside budget at realistic volume (this becomes moot if the fetch-time gates land first — measure after).
- **BUG FOUND AND FIXED 2026-07-25 (not previously in this register):** the `--dry-run` artifact path was double-prefixed. `run.ts` built a repo-relative path but `ctx.storage` is profile-rooted, so the file landed at `profiles/<p>/data/profiles/<p>/data/runs/<date>/sync_dryrun.json`. Two tests asserted contradictory paths (`sync.test.ts` profile-relative vs `run.test.ts` repo-relative), which is why it was never caught. FIXED: now profile-relative, sharing `RunFolder`'s root; both tests reconciled.

### 10. Profile bootstrap + operator controls (IMPORTANT) — two items CLOSED 2026-07-25, two still OPEN below

- **`src/cli/commands/profile.ts:54-59` seeds a new profile with `lanes: []`, `notifiers: []`, `routines: []`.** A freshly created v2 profile therefore runs zero lanes, sends no digest, never archives, and reports `passed` with 0 jobs — the exact silent-success shape this packet is trying to eliminate. This is also how `/cleanup` parity is lost per profile: the cleanup routine exists (`src/routines/cleanup/`, `when: 'post-sync'`) but is opt-in via `config.routines`. FIX: seed a working default set. TEST: a profile created by `jobbunny profile build` runs at least one lane and has cleanup wired.
  CLOSED 2026-07-25, via a different mechanism than the FIX line above: empty-lanes is now a doctor `red` (so the preflight hard-aborts a non-runnable new profile) rather than seeding default lanes.
- **No `JOBBUNNY_FRESH` equivalent.** v0 could force a clean same-day rescan; v2's `ResumeState.rescanReset()` (`src/adapters/lanes/linkedin/resume_state.ts`) has no operator-facing trigger, so there is no way to clear a same-day done-map. FIX: expose a flag. TEST: the flag clears the done-map and re-runs completed URLs.
  STILL OPEN as of 2026-07-25 — untouched this session.
- MINOR — `src/cli/wire.ts:255`: `maxAgeDays` is hardcoded to 30 for `inventoryFreshnessCheck`, ignoring any configured value.
  CLOSED 2026-07-25: `inventoryFreshnessCheck` maxAgeDays is now configurable, default 30.
- MINOR — no on-disk progress heartbeat replaces v0's `extract_progress.json`; stall detection is in-process only (`src/pipeline/runner/guard.ts:70-88`) and invisible to an external watchdog. Acceptable if nothing external watches; confirm at cutover.

### Definition of done for P9

P9 is complete when: every BLOCKING item above is closed with its test green; `npm run check` passes deterministically (no flaky test); one full non-dry v2 run has produced correct rows in the real Notion DB; the v2 scheduler is installed and v0's launchd jobs removed; `scripts/` is deleted with docs rewritten; no catch-and-continue path can report a passed run (source.ts, farm.ts and the lane guards all consistent); doctor preflight aborts a red run; the run cap exceeds the realistic stage budget; a notifier failure cannot change a run's exit code; two profiles scheduled at the same time run sequentially; and a newly created profile is runnable out of the box.

This register was compiled from a single broken run on 2026-07-25 and then extended by a code audit the same day. A further audit should be run immediately before Task 2 (deleting `scripts/`), since that deletion is irreversible.
