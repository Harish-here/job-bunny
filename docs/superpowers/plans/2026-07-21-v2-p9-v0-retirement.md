# v2 P9 — v0 Retirement + Docs Ground-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (mostly mechanical; review gates are the deletion inventory and the two rewritten docs).
> **Depends on:** P8 cutover complete **and** ≥7 days of green scheduled v2 runs (check `main-v2.md` soak start date + `last_run_result`/`result.json` history). Do not start early.

**Goal:** Delete v0 completely, rewrite CLAUDE.md and README.md from scratch for v2, prune branches, make `main-v2` the new `main`.

## Global Constraints

- Branch `chore/v2-retire-v0` off `main-v2`.
- **Deletion is by explicit inventory** (below) — nothing outside it; anything unexpected found during deletion gets surfaced, not silently removed.
- CLAUDE.md and README.md are **rewrites from scratch** (open a blank file), not edits — decision 24.
- Every step keeps `npm run check` green.

---

### Task 1: Soak gate check
- [ ] Verify ≥7 daily v2 runs since cutover, all `outcome: passed` (or failures explained + fixed). If not — stop, this phase waits.

### Task 2: Delete v0 code (the inventory)
- [ ] Delete: `scripts/` (entire tree — includes `scripts/ops/release.js`: port it to `src/cli/commands/release.ts` FIRST if `/wrap ship` is still wanted, decide with user), `scripts-v2-migrate/`, v0 launchd plists (`jobbunny schedule install` already replaced them — verify with `launchctl list | grep jobbunny` before deleting anything).
- [ ] Delete the 16 replaced commands from `.claude/commands/` (and skill mirrors): run, doctor, reconcile, cleanup, schedule, notify-setup, add-url, update-resume, remove-profile, extract, greenhouse, keka, filter, dedup, rank, sync. **Keep:** setup, page-analyse, structure, wrap, verify — rewrite each against v2 (wrap `jobbunny` commands / v2 paths).
- [ ] Delete per-profile v0 files after confirming migrator output is live: `filter_config.json`, `avoid.md`, `greenhouse_boards.md`, `keka_boards.md`, `resume_meta.json` (and `npm run meta` path). `search_urls.md` **stays** (still the lane's URL source). `page_inventory/*.md` deleted only where superseded by `<page>.json`.
- [ ] package.json: remove v0 scripts (`init|meta|reconcile|filter|dedup|rank|sync|release` as ported), remove `dotenv` dependency, verify `npm run check` green with `test: node --test src/`.

### Task 3: Rewrite CLAUDE.md from scratch
- [ ] Blank-file rewrite for v2 only: what Job Bunny is; commands (`jobbunny …`, `npm run check`); pointer to `main-v2.md` decision log + module contracts as the architecture source; the surviving hard rules restated for v2 (byte-exact Notion options, token-economy structure path, deadline-bound CDP, fail-soft taxonomy, seed-never-clobber, core purity + two-pair rule); profile layout; verify-on-rajni rule; PR gate. Keep it as tight as the v0 one — markdown is code.

### Task 4: Rewrite README.md from scratch
- [ ] Blank-file rewrite: what it is, install (Node 24, `npm ci`, `npx playwright install chromium`? — no: real Chrome via CDP, say so), `/setup` onboarding, `jobbunny` usage, scheduling, architecture one-pager linking the spec.

### Task 5: Branch + repo hygiene
- [ ] Delete merged/stale branches (list at execution time via `git branch --merged`; confirm each unmerged one with user before deletion).
- [ ] Make v2 the default: PR `main-v2` → `main` (or repoint default branch to `main-v2` then rename — pick with user based on protection rules), tag `v2.0.0` on merged HEAD via the release flow.
- [ ] Update `main-v2.md`: P9 ✅ — project complete; the file itself stays as the architecture decision record.

## Fetch-time gate parity (added 2026-07-25)

- CORE FACT: On 2026-07-25 a real `stage source` run for profile harish emitted 3275 jobs into the LLM `structure` stage, which blew its 30-minute timeout. v0's ceiling is ~80 new ATS jobs per run (`GH_MAX_NEW`, `KEKA_MAX_NEW`, both default 40 — `scripts/pipeline/greenhouse.js:155`, `scripts/pipeline/keka.js:211`, enforced `scripts/pipeline/ats_common.js:267-271`).
- ROOT CAUSE: v2 applies avoid/title rules only in the `filter` stage, which runs AFTER `structure` (`src/cli/wire.ts:580-591` — `source`:583, `structure`:585, `filter`:587). v0 applies the same logic at fetch time, before the LLM.
- GAP A — ATS source stage (`src/pipeline/stages/source.ts`), the 3275-job flood. Missing vs v0's `ats_common.js` per-job loop: card-altitude avoid+title gate (`ats_common.js:259-266`); `seen` ledger gate (`ats_common.js:251`); `maxNew` emitted-job cap (`ats_common.js:267-271`). `makeSourceStage`'s only limits are `maxProbesPerRun` (caps BOARDS probed, `source.ts:152`) and `laneBudgetMs` (wall-clock) — neither caps emitted jobs. The Notion-cache gate added 2026-07-25 (`ca6d054`) is NOT the fix: it suppressed 12 of 3275 (0.37%) because the profile's Notion cache holds only 46 entries.
- GAP B — LinkedIn lane (`src/adapters/lanes/linkedin/`). The card-level title/avoid gate ALREADY EXISTS and works: `lane.ts:165` calls `gateCards(cards, this.filterCfg)` → `evaluateCard` (`harvest.ts:228`) on raw card title+company BEFORE `jd_open.ts` opens any detail pane, emitting real DroppedRecords. DO NOT re-implement it. Missing vs v0's `applyCardGates` (`scripts/pipeline/extract/filters.js`): cache-skip against known Notion job ids (`filters.js:46`); cross-URL run-dedup on job id (`filters.js:57`, v2 tracks only a `companiesSeen` set at `lane.ts:173`); per-URL card cap (v0 `CARD_CAP` from `EXTRACT_MAX_CARDS`, `extract.js:66`). Each missing gate costs a real page-open: goto 30s / click 15s / waitFor 15s / evaluate 10s (`jd_open.ts:34-37`).
- MECHANISM ALREADY EXISTS — wiring, not new logic. `src/core/filter/engine.ts:26` exports `evaluateCard(card: CardInput, cfg: FilterConfig): Verdict[]`; `CardInput` (`src/core/filter/rules/types.ts:4-8`) is `{ title: string; company: string; location?: string }` — plain strings, nothing from the LLM stage. v2 encodes v0's `{ only: ["title"] }` subsetting structurally: card-runnable rules define `evalCard` (`title.ts:45`, `company.ts:25`); rules needing structured data omit it (`types.ts:15-17`).
- DESIGN NOTE: the title gate is the workhorse, not the cache gate. A v0 title fails on a blocked function term, OR no seniority match, OR no domain match (`scripts/pipeline/title_filter.js:32-55`). A bare `maxNew` cap WITHOUT the title gate yields N arbitrary jobs rather than the N most relevant. Gate first, measure what survives, add a cap only if the number is still unreasonable — a silent truncation cap hides problems.
- CROSS-REFERENCE: satisfies the CLAUDE.md constraint that avoid-list companies must drop on card data before JDs open.

## P9 = final closure — complete open-item register (compiled 2026-07-25)

P9 is the last packet. Nothing may be carried past it. Each item below states the fix and the test that proves it. Items marked BLOCKING must be closed before the launchd cutover; items marked NON-BLOCKING may land in P9 but do not gate the cutover.

### 1. Fetch-time gate parity (BLOCKING)

Cross-reference the existing "Fetch-time gate parity" section above; do not duplicate its detail. Summarised as three ATS sub-items and three LinkedIn sub-items:

- ATS `src/pipeline/stages/source.ts`: wire `evaluateCard` gate; add `seen` ledger; add `maxNew` cap.
  TESTS: a job whose card fails the title rule is never emitted; a job whose company is on the avoid list is never emitted; both emit DroppedRecords with the right rule strings (`title.domain`/`title.function`/`title.seniority`, `company.avoid`); the cap truncates deterministically and logs once; a replay test asserting the harish fixture emits a two-digit number of jobs, not ~3275.
- LinkedIn `src/adapters/lanes/linkedin/`: cache-skip vs known Notion ids; cross-URL run-dedup on job id; per-URL card cap.
  TESTS: a card whose id is in the cache never reaches `jd_open`; the same job id appearing under two URLs opens exactly once; the cap bounds page-opens per URL.

### 2. Silent-failure guards (BLOCKING)

- `src/pipeline/stages/farm.ts` reports `outcome: passed` when EVERY farming lane throws — it catches a whole-lane failure as `ctx.logger.warn('farming lane failed entirely', ...)` and continues. A total LinkedIn outage currently looks like a clean run. This is the same class of defect as the zero-card harvest already fixed in `68a2e9b`.
  FIX: fail the stage when all lanes fail (distinguish "some lanes degraded" from "everything died").
  TEST: all-lanes-throw produces a failed run; one-of-two-lanes-throws still passes with a warn.
- Diagnose why `farm` harvested 0 jobs in 227s on the 2026-07-25 run. Unknown whether stale login, further selector drift, or the new harvest readiness gate (`68a2e9b`) correctly refusing a bad page. MUST be diagnosed against live Chrome before another full run is spent.
  TEST: an authenticated live harvest yields a non-zero card count through the adapter (not via a standalone script — the 2026-07-25 CDP bug was missed precisely because the verify script exercised a different code path than the pipeline).

### 3. Browser lifecycle (BLOCKING)

- `CdpChromeProvider` kills Chrome on exit even for an instance it merely REUSED rather than launched (unless `JOBBUNNY_KEEP_BROWSER=1`). This took down a logged-in user browser mid-session on 2026-07-25.
  FIX: only kill what this process launched; track launched-vs-reused.
  TEST: reused instance survives provider disposal; launched instance is killed.

### 4. Test-suite reliability (BLOCKING — it gates CI)

- `src/adapters/browser/cdp-chrome/provider.test.ts:366` asserts a CDP-connect timing under a 20ms cap and intermittently takes ~800ms under load, randomly reddening `npm run check` and the CI `test` check.
  FIX: loosen the cap or make the assertion time-independent.
  TEST: the assertion passes deterministically under load.

### 5. Correctness carry-forwards from P6/P7 (NON-BLOCKING unless noted)

- BLOCKING: sync `retries: 1` can double-insert on a HARD mid-batch failure (per-page failures are SoftError and do not trigger it). FIX: make `syncJobs` retry-idempotent, or set retries 0 at wiring. TEST: a hard failure mid-batch followed by a retry inserts each job exactly once.
- `dedup`'s cache Map keyed title+company overwrites entries differing only by city, despite `CacheEntry.city` existing to restore v0's title+company+city repost key. TEST: two cache entries differing only by city are both retained and matched independently.
- `compress` passthrough keyed by id means duplicate ids collapse last-wins with NO DroppedRecord — a funnel accounting hole. TEST: duplicate ids into compress produce a DroppedRecord rather than a silent collapse.
- `dedup` runs AFTER `structure` in the stage order (`src/cli/wire.ts:580-591`), so the LLM pays for jobs that are about to be deduped. Decide whether to reorder. TEST: if reordered, a known-duplicate never reaches the LLM stage.
- `rank`'s YoE axis is neutral-defaulted because no YoE field exists on `StructuredJD`; real score ceiling is 95, nominal 100. Decide: add the field or document the ceiling permanently.
- depcruise `includeOnly: '^src'` means the src→scripts boundary is NOT mechanically enforced. After `scripts/` is deleted this becomes moot — confirm at deletion time rather than fixing now.

### 6. Never-verified paths (BLOCKING)

- No v2 run has EVER completed end to end. This is the headline risk: a filter/dedup/rank divergence would first surface as wrong rows in production Notion. The ≥3-day v0-vs-v2 parity soak was WAIVED by the user 2026-07-25.
  TEST: one full `jobbunny run --profile <p> --dry-run` completing with non-zero counts through farm -> source -> structure -> sync, followed by one non-dry run reviewed row-by-row against expectations.
- P7 Notion adapter WRITE path has never spoken to the real API (`reconcile`'s read path was exercised 2026-07-25, 46 entries). The specific risk: a byte-exact select option string that live Notion rejects in practice (`scripts/notion/schema.js`).
  TEST: a real insert + a real anchored update against a SCRATCH Notion DB — never a real profile DB.
- P8 Task 6 (rajni full-pipeline verify) is BLOCKED on a scratch Notion DB id; rajni's `notion_db_id` is empty so the migrator emits `settings.notion.dbId: ""`.
  ACTION: obtain a throwaway Notion database id + `NOTION_TOKEN`.

### 7. Cutover mechanics (BLOCKING)

- `jobbunny schedule install` has NOT been run; v0's `com.jobbunny.run.*` launchd jobs have NOT been removed. v0 remains the scheduled pipeline. Per the cutover runbook section 5 step 3, removal is explicit, not implicit.
  TEST: after cutover, exactly one scheduler is installed; `launchctl list` shows the v2 jobs and none of the v0 jobs; a scheduled fire produces a run folder and a Telegram digest.
- Wiring constraint to re-verify at cutover: pipeline `stallMs` MUST exceed the structure provider's per-call `timeoutMs` (structure only beats between batches, so a tighter stall watchdog false-kills a live batch).
- The migrator leaves `avoid.md`'s alias map unmapped (v2 has no per-profile alias map). Decide: implement or accept the loss explicitly.

### 8. v0 retirement proper

- Delete `scripts/`, retire the v0 slash commands, rewrite docs ground-up (see locked decision 24 in `main-v2.md`).
  GATE: do this LAST, only after items 1-7 are closed and v2 has run clean in production for a period you nominate. Deleting `scripts/` destroys the reference implementation every parity question in this document is answered against.

### Definition of done for P9

P9 is complete when: every BLOCKING item above is closed with its test green; `npm run check` passes deterministically (no flaky test); one full non-dry v2 run has produced correct rows in the real Notion DB; the v2 scheduler is installed and v0's launchd jobs removed; and `scripts/` is deleted with docs rewritten.
