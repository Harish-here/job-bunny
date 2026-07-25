# v2 P8 — CLI, Wiring, Parity & Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.
> **Depends on:** P1–P7 all merged. This phase turns modules into the product and executes cutover.

**Goal:** The `jobbunny` CLI, `wire.ts` composition, doctor aggregation, Telegram notifier, launchd scheduler, setup/profile-build, the v0→v2 config migrator, dry-run parity, and the cutover itself.

**Pin at phase start:** Telegram digest format from `scripts/notify/telegram_format.js`; launchd plist shape from `scripts/ops/schedule.js`; v0 profile file formats from `scripts/lib/config.js`.

## Carry-in from P6/P7 (detail in `main-v2.md`'s P6/P7 entries — do not re-derive, just act)

- Runner `stallMs` MUST exceed structure's per-call provider `timeoutMs` (structure only beats between batches; a tighter stall watchdog false-kills a live batch).
- `sync` has `retries: 1`; a hard mid-batch failure after partial inserts can double-insert on retry (per-page failures are already `SoftError` and don't trigger it) — make `syncJobs` retry-idempotent or set `retries: 0` when wiring.
- `FilterConfig`/`RankConfig` reach their stages via factory injection (`makeFilterStage(cfg)` / `makeRankStage(cfg)`); composing them from `profile.json`/`filter_config.json` into `wire.ts` is this phase's job.
- Cleanup routine's `ArchivePolicy` comes from `ctx.config.settings.cleanup` (`{ passedOlderThanDays: 7, untouchedOlderThanDays: 30 }` defaults); dry-run is owned by the connector (`NotionConnectorSettings.dryRun`, defaults `true`) — wiring must not silently flip it on.
- Tail order `reconcile → … → filter → dedup → rank → sync`; `dedup` fails loud without reconcile's cache file, so `reconcile` must wire ahead of it.
- **Non-blocking, be aware:** depcruise's `includeOnly: '^src'` leaves `src/`→`scripts/` mechanically unenforced; dedup's cache index keys on title+company only (city collisions overwrite); rank's YoE axis is neutral-defaulted (ceiling 95/100); compress's id-keyed passthrough collapses duplicate ids last-wins with no `DroppedRecord`.

**Deferred live-verify batch — this gates Task 6, not Task 7.** (Task 6 already specifies live Chrome + claude-cli + a scratch Notion DB, so it *is* this batch; running them separately would only mean doing it twice.)
- ✅ **P4 LinkedIn authenticated harvest — DONE 2026-07-25.** Re-logged in; `li_at` valid to 2027-07-20; authenticated jobs-search renders `.scaffold-layout__list` + 25 `li[data-occludable-job-id]` cards with clean title/company extraction. **No UI drift — `page_inventory/linkedin__jobs-search.md` did NOT need regenerating.**
- ⏳ P7 Notion adapter: every test to date is stub-driven, never hit the real API. **Blocked on the user providing a scratch Notion DB id + `NOTION_TOKEN`** — never a real profile DB (`profiles/harish/`, `profiles/uvashree/`); use `profiles/rajni/` fixture conventions. Watch for byte-exact select-option strings live Notion rejects that stubs can't catch.

## Global Constraints

- Branch `feat/v2-p8-surface` off `main-v2` (cutover steps get their own `chore/v2-cutover` PR). All P1 constraints apply.
- `cli/wire.ts` is the **only** file importing from `src/adapters/` (depcruise already enforces).
- Digest single-sender: the `run` command sends success/failure digests from `RunResult`; nothing else sends digests.
- Profiles run strictly sequentially (shared Chrome).
- Parity gate before cutover: ≥3 consecutive daily dry-run diffs reviewed. Cutover only on explicit user go.

## File Structure

```
src/cli/
  main.ts + main.test.ts             parseArgs dispatch: run|doctor|reconcile|setup|stage|routine|schedule|lane|profile
  wire.ts + wire.test.ts             config strings → adapter instances (sole composition point)
  commands/                          one file per subcommand (two-pair rule)
    run.ts + run.test.ts             compose stages, runPipeline, digest send, exit code
    doctor.ts + doctor.test.ts       aggregate DoctorChecks, red ⇒ exit 1
    stage.ts / routine.ts / reconcile.ts / schedule.ts (+ tests)
    lane_add_url.ts + test           port v0 add_url.js URL-stripping rules
    profile.ts + test                build (seed, never clobber) / remove
    setup.ts + test                  idempotent onboarding steps (wizard stays /setup)
  index.ts
src/ops/doctor/
  aggregate.ts + aggregate.test.ts   collect checks from wired adapters + core (env keys, profile shape)
  index.ts
src/adapters/notify/telegram/
  telegram.ts + telegram.test.ts     Notifier impl over fetch, TELEGRAM_BOT_TOKEN
  format.ts + format.test.ts         digest text from RunResult (funnel summary)
  index.ts
src/adapters/scheduler/launchd/
  plist.ts + plist.test.ts           plist generation from ScheduledJob[]
  launchd.ts + launchd.test.ts       Scheduler impl (launchctl load/unload/list)
  index.ts
scripts-v2-migrate/migrate.ts + test one-off v0→v2 profile migrator (deleted in P9)
docs/superpowers/specs/…-cutover-runbook.md   written in Task 7
```

---

### Task 1: Telegram notifier
TDD `format.ts` (digest from a fixture `RunResult`: outcome, per-stage funnel line, failure reason; alert passthrough) and `telegram.ts` (fetch stub: correct bot endpoint, chat_id from settings zod `{ chatId: number }`, non-200 throws). Live smoke to the user's own chat. Commit `feat(v2): telegram notifier`.

### Task 2: launchd scheduler
TDD plist generation (one job per distinct time across profiles, label `com.jobbunny.<HHMM>`, program args `jobbunny run --profile <p> --headless` chained sequentially per v0 run_scheduled semantics, coarse backstop timeout above runCap) and `launchctl` wrapper with spawn stub. Commit `feat(v2): launchd scheduler adapter`.

### Task 3: wire.ts + doctor aggregation
> **✅ DONE** — commits `2c81455` (doctor checks surface) + `10de331` (full runnable composition: runtime adapter registry, `PipelineCtx` builder, ordered 10-stage array, cleanup routine registry). Decisions: `RankConfig` from `settings.rank` (fully-defaulted, migrator populates it); `llm`/`browser` convention-selected (`claude-cli`/`cdp-chrome`) since they aren't in `PipelineConfig`; `launchd` descoped from ctx (only the `schedule` command builds it); missing `NOTION_TOKEN` resolves `wire()` (doctor intact) via a throwing-stub connector that rejects on first use. Note: `wire()` has no Storage-injection seam on the live path (tests use a temp dir); `ctx.logger` is a no-op placeholder that `run` overrides with `JsonlLogger`.

**Interfaces — Produces:** `wire(profileName: string): Promise<{ ctx: PipelineCtx; stages: StageDef<StagePayload, StagePayload>[]; routines: Routine[]; checks: DoctorCheck[] }>` — loads `profiles/<p>/profile.json` (`PipelineConfigSchema`), `filter.json`, maps names→constructors (`linkedin|greenhouse|keka`, `notion`, `telegram`, `claude-cli`, `cdp-chrome`, `launchd`), each adapter zod-validating its `settings.<name>`; unknown name ⇒ loud `ConfigError`-style throw at startup. Doctor aggregate = core checks (env tokens present, profile parses, filter.json parses) + every wired adapter's checks (CDP reachable, inventory freshness, Notion DB reachable, bot token valid). TDD with fake registry; commit `feat(v2): wire.ts + doctor aggregation`.

### Task 4: CLI commands
> **✅ DONE** — commits `b444a67` (`main`/`run`/`doctor`), `03982d2` (bin entry), `044c0a5` (the remaining seven + full dispatch). 1150 tests green. Used `node:util` parseArgs; exit codes 0 pass / 1 failed|red|thrown / 2 usage. Relocated the pure digest formatter adapters→ops (`src/ops/observability/digest.ts`) — the `run` command can't import `src/adapters`. `run` watchdog: `stallMs=360_000` (> structure's 300_000 provider timeout), `runCapMs=1_800_000`; `sync` already ships `retries:0` (carry-in idempotency concern resolved in P7). `run` routine order: pre-run before stages, post-sync only on `passed`; digest sent on both outcomes.
>
> Task-4-tail decisions: `bin` is `jobbunny` → `src/cli/main.ts`, and `isMain()` realpath-resolves `process.argv[1]` (the npm bin symlink otherwise makes the entry guard silently no-op). `schedule install` is the one cross-profile command (no `--profile`); it honors v0's `schedule.enabled` so migrating a disabled profile can't silently start scheduling it, and fail-softs past an unreadable `profile.json`. `wire.ts` gained a second, independent composition point `wireScheduler()` rather than putting launchd in `PipelineCtx`. `cli/commands/stage.ts` imports `pipeline/runner/guard.ts` directly so a single-stage run reuses runPipeline's timeout/retry/stall semantics — `runner/index.ts`'s "intentionally internal" note now records this one deliberate caller. `profile remove` requires `--force` and refuses the committed `rajni` fixture.

TDD `main.ts` dispatch + each command against the wired fakes: `run` (stage order per spec §4: reconcile→farm→source→compress→structure→assemble→filter→dedup→rank→sync; routines at declared points; digest sent from RunResult; exit code = outcome), `doctor` (table output, red⇒1), `stage <name>` (single stage from latest checkpoint), `routine cleanup`, `reconcile`, `schedule install|remove`, `lane add-url` (v0 param-stripping rules ported with tests), `profile build` (seed-never-clobber diff behavior), `setup` (idempotent step list, resumable). Commit per command group.

### Task 5: Config migrator
> **✅ DONE** — commit `701511a`. 30 tests; added to the `npm run check` gate (tsconfig include, biome includes, test glob). rajni dry run reviewed and clean; **`--write` not yet run on any profile.**
>
> Mapping decisions: `profile.json` is **MERGED, never replaced** — v0/v2 key sets are disjoint, so one file serves both trees through the soak. v2's filter config moved to `filter.json` (commit `03982d2`) because v0 owns `filter_config.json` with an incompatible shape; sharing the name would break v0 on the first `--write`, making Task 7's parallel soak impossible. Legacy singular `schedule.time` (rajni has it; `harish` already has `times[]`) is back-filled as `times: [time]` with `time` preserved — a no-op for v0's `schedule.js`, which already prefers `times`, and the only shape v2's `ScheduleSchema` reads. Filter `timezones` = `acceptable ∪ borderline` at `hard` severity: v0 *keeps* borderline zones with a rank penalty rather than dropping them, so the union drops exactly what v0 drops, and the tiering itself survives in `settings.rank.location.{acceptable,borderline}Timezones`. Work types normalize to v2's lowercase enum (`"On-site"` → `"onsite"`); an unrecognized value throws rather than silently narrowing the filter. `settings.notion.dryRun` always emitted `true`. `routines` stays `[]` — v0 cleanup is not part of `/run`. Unmapped (reported, not dropped): `home_country`, `remote.eligible_countries`, avoid.md's alias map.

`scripts-v2-migrate/migrate.ts --profile <p> [--write]`: v0 `profile.json`+`filter_config.json`+`avoid.md`+`greenhouse_boards.md`/`keka_boards.md`+`search_urls.md` → v2 `profile.json` (PipelineConfig), `filter.json`, registry curated records. Dry-run prints the full would-write diff; TDD against a fixture copy of rajni's v0 files. Migrate **rajni only** now; real profiles at cutover.

### Task 6: Full-pipeline rajni verify
> **⏸ BLOCKED — needs a scratch Notion DB id + `NOTION_TOKEN` from the user.** Everything else is ready: the CLI is invocable as `jobbunny`, the migrator produces rajni's v2 config, and the LinkedIn half of the live-verify batch is done. rajni's v0 `notion_db_id` is empty, so the migrator emits `settings.notion.dbId: ""` and warns the profile is not runnable until it is filled in. **Do not point this at a real profile DB.**
>
> Order once unblocked: fill rajni's `notion_db_id` → `node scripts-v2-migrate/migrate.ts --profile rajni --write` → `jobbunny doctor --profile rajni` green → `jobbunny run --profile rajni`.

`jobbunny doctor` green → `jobbunny run --profile rajni` end-to-end (live Chrome + claude-cli + scratch Notion DB) → funnel sane, digest received. Fix-forward anything found; this is the phase's real gate. Update `main-v2.md` (P8 core ✅).

### Task 7: Parity + cutover (own PR: `chore/v2-cutover`; each step needs explicit user go)

> **Carry-forward discovered in Task 7 — `ctx.storage` rooting.** `wire()` builds
> `new FsStorage(root)` where `root` is the **repo root**, not `profiles/<p>/data`,
> because `loadInventory` reads the *shared, repo-root* `page_inventory/<page>.json`
> through the same storage handle (`src/cli/wire.ts:377`). But every per-profile
> stage artifact goes through that handle too with a bare relative key —
> `cache/entries.json`, `registry/companies.json`, `registry/companies_seen.json`,
> `structure/{table,passthrough,decisions,decisions.partial}.json`. So they land in
> the **repo root** and **two profiles would share one cache/registry**. Harmless
> today only because no v2 run has ever executed end-to-end (Task 6 never ran), so
> nothing is on disk to migrate. Fixing it needs either two storage handles (shared
> repo-root vs per-profile) or a profile-prefix convention — cross-cutting across
> every stage, so **deferred to P9**, not patched inside Task 7.
- [ ] Migrate real profiles with `--write` after user reviews dry-run diffs.
- [x] **✅ DONE** — `--dry-run` flag on `sync`, commit `3f4b902`. `jobbunny run --profile <p> --dry-run` skips `connector.syncJobs` entirely and writes the would-write set to `profiles/<p>/data/runs/<date>/sync_dryrun.json`; jobs/dropped pass through untouched and the digest carries a `⚠️ DRY RUN` banner. **Two decisions:** (a) the artifact records *which* jobs would be written (`id/company/title/url/city?/score?/verdict?`, `verdict` ← `evaluation.excitement`), **not** the exact Notion property payload — that mapping lives in `adapters/db/notion/sync.ts` and is deliberately not duplicated; (b) the path is spelled profile-first because **`ctx.storage` is rooted at the REPO root, not the profile data dir** (see carry-forward below).
- [~] **WAIVED by the user 2026-07-25** ("don't worry about v0 runs"). The ≥3-day v0-vs-v2 dry-run diff soak was not run. Risk left un-retired: v2 has never completed an end-to-end run against real data, so a filter/dedup/rank divergence vs v0 would first surface as wrong rows in production Notion. Recorded in the runbook.
- [ ] Write `docs/superpowers/specs/2026-07-25-v2-cutover-runbook.md`: diffs observed, accepted divergences, rollback = `node scripts/ops/schedule.js` reinstall from `main`.
> ## 🛑 CUTOVER BLOCKED — first end-to-end v2 run, 2026-07-25 (`harish`, `--dry-run`)
>
> The full-pipeline dry run **exited 0 and reported `outcome: passed`, but did
> nothing**: every stage `0 -> 0`, `sync_dryrun.json` `count: 0`. Two defects,
> both of which would have shipped silently had the launchd cutover gone first.
>
> **Blocker 1 — LinkedIn farm harvests zero cards, silently, and passes.**
> `farm` burned 59.9s across all 21 of harish's search URLs, captured 0 jobs,
> emitted 0 `DroppedRecord`s, and logged **nothing** (`run.log` holds 4 lines
> total: reconcile, structure ×2, the dry-run banner). `lanes/linkedin/extract_resume.json`
> shows all 21 URLs `markDone` with capture count `0`. Root cause: `LinkedInLane.source()`
> does `page.goto(url)` and calls `harvestCards` **immediately** — there is no
> bounded wait for the card-list selector to attach, so the harvest script reads a
> still-hydrating SPA DOM. `buildHarvestScript` then does
> `listEl ? listEl.querySelectorAll(cardSel) : []` (`harvest.ts:66`) and returns
> `[]` with no log and no throw; the lane's aggregate-failure guard only counts
> URLs that **threw**, so 21/21 empty reads is not "shaped like a logout wall" to it.
> v0 does not have this hole: `scripts/pipeline/extract/cards.js:35-46` `runAssertions`
> waits (bounded) for each `must_exist` selector **and** `job_card` to attach, then
> **throws** when `count < min_job_cards`. v2 ported neither the wait nor the
> minimum-cards assertion. Fix = both, plus a zero-card read must produce a loud
> signal rather than a clean `markDone`.
>
> **Blocker 2 — the `ctx.storage` rooting carry-forward is not cosmetic; it
> silently disabled the ATS lanes.** The run created `cache/`, `lanes/`,
> `registry/`, `structure/` **in the repo root** (all four now untracked there).
> `source` read repo-root `registry/companies.json` — a **0-entry** list it had just
> created — instead of the migrated `profiles/harish/data/registry/companies.json`
> with its **27 curated companies**. Hence `source: 0 -> 0` in 3ms: Greenhouse and
> Keka never probed anything. This is no longer safe to defer to P9 behind a soak;
> it must be fixed before any real run.
>
> Reconcile is the one stage that genuinely worked: 46 entries rebuilt from live
> Notion (first real end-to-end exercise of the P7 adapter against the API).
>
> **Consequence: `jobbunny schedule install` was NOT run and v0's launchd jobs were
> NOT removed.** v0 remains the scheduled pipeline. Cutover stays blocked on both
> fixes plus a dry run that produces non-zero counts.

- [ ] Cutover: `jobbunny schedule install`, **then explicitly remove v0's launchd jobs**. ⚠️ **This line was wrong as originally written** — install does *not* replace v0's jobs. The labels don't collide (v0 `com.jobbunny.run.<HHMM>` per `scripts/ops/schedule.js:108`; v2 `com.jobbunny.<HHMM>` per `src/adapters/scheduler/launchd/plist.ts:176`) and v2's stale-plist reconcile matches `/^com\.jobbunny\.(\d{4})\.plist$/` (`launchd.ts:42`), which `com.jobbunny.run.0700.plist` fails. Left alone **both fire: double run, double digest.** Removal procedure is §5 step 3 of the runbook. v0's *code* stays untouched on disk for the ≥7-day soak (P9 gate); only its launchd jobs go.
- [ ] Update `main-v2.md` (P8 ✅, soak start date). PR.
