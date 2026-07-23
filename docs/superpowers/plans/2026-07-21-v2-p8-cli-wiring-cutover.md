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

**Before the parity cutover run (Task 7), run this deferred live-verify batch once — not blocking earlier tasks:**
- P4 LinkedIn authenticated harvest: `.chrome-debug` session was expired at P7 handoff — re-login, rerun the harvest verify, regenerate `page_inventory/linkedin__jobs-search.json` via `/page-analyse` only if the authenticated UI genuinely drifted.
- P7 Notion adapter: every test to date is stub-driven, never hit the real API. Needs a scratch Notion DB + `NOTION_TOKEN` — never a real profile DB (`profiles/harish/`, `profiles/uvashree/`); use `profiles/rajni/` fixture conventions. Watch for byte-exact select-option strings live Notion rejects that stubs can't catch.

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
**Interfaces — Produces:** `wire(profileName: string): Promise<{ ctx: PipelineCtx; stages: StageDef<StagePayload, StagePayload>[]; routines: Routine[]; checks: DoctorCheck[] }>` — loads `profiles/<p>/profile.json` (`PipelineConfigSchema`), `filter.json`, maps names→constructors (`linkedin|greenhouse|keka`, `notion`, `telegram`, `claude-cli`, `cdp-chrome`, `launchd`), each adapter zod-validating its `settings.<name>`; unknown name ⇒ loud `ConfigError`-style throw at startup. Doctor aggregate = core checks (env tokens present, profile parses, filter.json parses) + every wired adapter's checks (CDP reachable, inventory freshness, Notion DB reachable, bot token valid). TDD with fake registry; commit `feat(v2): wire.ts + doctor aggregation`.

### Task 4: CLI commands
TDD `main.ts` dispatch + each command against the wired fakes: `run` (stage order per spec §4: reconcile→farm→source→compress→structure→assemble→filter→dedup→rank→sync; routines at declared points; digest sent from RunResult; exit code = outcome), `doctor` (table output, red⇒1), `stage <name>` (single stage from latest checkpoint), `routine cleanup`, `reconcile`, `schedule install|remove`, `lane add-url` (v0 param-stripping rules ported with tests), `profile build` (seed-never-clobber diff behavior), `setup` (idempotent step list, resumable). Commit per command group.

### Task 5: Config migrator
`scripts-v2-migrate/migrate.ts --profile <p> [--write]`: v0 `profile.json`+`filter_config.json`+`avoid.md`+`greenhouse_boards.md`/`keka_boards.md`+`search_urls.md` → v2 `profile.json` (PipelineConfig), `filter.json`, registry curated records. Dry-run prints the full would-write diff; TDD against a fixture copy of rajni's v0 files. Migrate **rajni only** now; real profiles at cutover. Commit `feat(v2): v0→v2 config migrator`.

### Task 6: Full-pipeline rajni verify
`jobbunny doctor` green → `jobbunny run --profile rajni` end-to-end (live Chrome + claude-cli + scratch Notion DB) → funnel sane, digest received. Fix-forward anything found; this is the phase's real gate. Update `main-v2.md` (P8 core ✅).

### Task 7: Parity + cutover (own PR: `chore/v2-cutover`; each step needs explicit user go)
- [ ] Migrate real profiles with `--write` after user reviews dry-run diffs.
- [ ] Add `--dry-run` flag to `sync` stage (would-write set → `runs/<date>/sync_dryrun.json`, no Notion writes).
- [ ] ≥3 consecutive days: scheduled v0 runs as normal; manual/parallel v2 runs with `--dry-run`; diff `sync_dryrun.json` vs v0's actual writes (v0 `cache.json` delta) — divergences fixed or explicitly accepted in the runbook.
- [ ] Write `docs/superpowers/specs/2026-XX-XX-cutover-runbook.md`: diffs observed, accepted divergences, rollback = `node scripts/ops/schedule.js` reinstall from `main`.
- [ ] Cutover: `jobbunny schedule install` replaces v0 launchd jobs. v0 stays untouched on disk for the ≥7-day soak (P9 gate).
- [ ] Update `main-v2.md` (P8 ✅, soak start date). PR.
