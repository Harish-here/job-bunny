# Changelog

Versions follow the v0 LinkedIn-lane code semver (`0.x.y`); the forward-looking
feature→version map lives in the [Notion roadmap](https://app.notion.com/p/381cbef64ec281d1b3a5ebd4f3d0fd1e).

## [1.3.1] — 2026-07-14

### Fixed
- **`/extract` could hang for many minutes with no way out.** Each locator action inside `collectCards` already carried Playwright's ~30s default action timeout, but nothing bounded the total time across all cards on a page — under DOM instability (e.g. a reflowing third-party ad iframe), several per-card actions could each hit their full ~30s ceiling, and across dozens of cards that compounded into a many-minute hang. Added a hard wall-clock cap (`EXTRACT_COLLECT_CARDS_MAX_MS`, default 120s); on hit, `extract.js` now warns and returns the cards collected so far instead of throwing, consistent with the file's existing skip-and-continue convention.

### Notes
- CLAUDE.md gained Architecture and Development sections (`scripts/`'s domain-folder layout and pipeline stage chain, plus the `npm test` / colocated-`*.test.js` convention) — no behavior change, but closes gaps a future Claude instance would otherwise have to piece together from multiple files.

## [1.3.0] — 2026-07-14

### Added
- **Deterministic release mechanics** — `scripts/ops/release.js` owns the mechanical git/GitHub spine of `/wrap ship`: preflight (clean tree, on `main`, up to date with origin, tag doesn't already exist, `CHANGELOG.md` has a dated block for the target version) → version-sync (`npm version --no-git-tag-version` + README badge regex-replace, both skipped if already correct) → release branch/commit/push/PR → bounded polling for the `test` check (15s interval, 10m cap) → a merge confirmation pause (never unconditional auto-merge) → tags only after confirming the merged commit is reachable from `origin/main` post-pull (fixes the "tag the pre-squash local commit, tag an orphan" hazard). Fully idempotent — re-running after any failure re-derives state and resumes from wherever it left off rather than erroring or duplicating work. Deliberately never writes release-note prose — that stays a `/wrap ship` judgment step.

### Changed
- `.claude/commands/wrap.md`'s `/wrap ship` mode rewritten to call `node scripts/ops/release.js X.Y.Z` instead of hand-running `git`/`gh` every release.

### Notes
- 27 new `node:test` unit tests (`scripts/ops/release.test.js`) cover the pure decision functions (`parseVersion`, `changelogHasVersionBlock`, `packageJsonVersion`, `updateReadmeBadge`, `resolveResumeStage`); suite is 213/213 green.
- Not yet exercised end-to-end against real GitHub prior to this release — this release is that first live exercise.

## [1.2.1] — 2026-07-14

### Fixed
- **Real-Chrome CDP attach failed with "Browser context management is not supported."** `connectOverCDP`'s default `Browser.setDownloadBehavior` override doesn't work when attaching to a real, user-owned Chrome (our persistent `.chrome-debug/` LinkedIn session) rather than a browser Playwright launched itself. Now passes `noDefaults` (added in Playwright 1.60 for exactly this case); bumped the `playwright` dependency floor to `^1.60.0` so a fresh install can't silently resolve below the version that supports it.

## [1.2.0] — 2026-07-13

### Changed
- **`scripts/` reorganized into domain folders** — `lib/` (config, util, io, cli, env_file, prompt), `pipeline/` (extract, greenhouse, compress, assemble, filter, dedup, rank, avoid, title_filter), `notion/` (schema, client, cache, notion_sync, cleanup), `notify/` (dispatcher + telegram connector — `notifiers/` dissolved in), `ops/` (doctor, schedule, run_scheduled.sh, run markers), `setup/` (init, notify_setup, generate_meta, add_url). Pure `git mv` — basenames and behavior unchanged, tests stay colocated. Every path reference updated (commands, `package.json`, `run_scheduled.sh`, docs).
- **Duplication removed via 5 new shared modules**: `lib/io.js` (`readJson`/`writeJson`, replacing ad-hoc JSON boilerplate in ~9 stages), `notion/client.js` (Notion client + `NOTION_TOKEN` guard, previously duplicated in `cache.js`/`notion_sync.js`/`cleanup.js`), `lib/cli.js` (the `file://argv[1]` run-guard and `--flag value` parser, previously reimplemented per-script), `lib/env_file.js` + `lib/prompt.js` (`.env` read/write and readline prompts, byte-for-byte duplicated between `init.js` and `notify_setup.js`), and `notion/schema.js`'s new `PROP` constants (Notion column names were hardcoded independently in the writer and reader sides — `notion_sync.js`'s own header claimed "from schema.js" without ever importing it).
- **Legacy mode and `/migrate` removed.** The pre-v0.7 root-layout fallback is gone — a checkout with no `config.json` and no `JOBBUNNY_PROFILE` now fails loud pointing at `/setup`, instead of silently falling back to root-path resolution. Pre-v0.7 checkouts convert via tag `v1.1.0`'s `/migrate` before upgrading past this release.
- **`/setup` revamped** to cut onboarding friction: Notion prerequisites (integration token, shared root page) are collected up front instead of causing a mid-wizard failure; the résumé step now has the agent parse a PDF/text résumé directly into `resume.json` (one follow-up round + one confirmation) instead of leaving all 8 fields as hand-edit homework; the title-filter step derives `filter_config.json`'s domain/function terms from the target roles already gathered instead of dumping raw JSON on the user to edit blind. Hand-editing `resume.json` directly remains a supported fallback.

### Fixed
- **Multi-city `location` silently broke filtering and ranking.** Setting `resume.json`'s `location` to an array (e.g. two home cities) passed through `generate_meta.js` unvalidated; `filter.js`/`rank.js` then string-coerced the array via `normalizeName()`, which joins it into one string that can never equal a single city — every on-site job was silently dropped and rank's 20-point home-city credit was silently zeroed, with no crash and no test coverage. New `homeLocations()`/`isHomeCity()` in `lib/util.js` properly support a string or an array of home cities end-to-end; `generate_meta.js` and `doctor.js` now shape-validate `location` (and every other résumé field) and fail loud on a bad shape instead of letting it corrupt scoring downstream.

### Notes
- **Rollout:** anyone with an installed `/schedule` cron must re-run `/schedule` once after upgrading — the previously-installed launchd plists embed the pre-move absolute path to `run_scheduled.sh`; until re-run, scheduled slots fail silently at the bash level with no Telegram alert (notify.js never runs).
- Landed as a single squash-merged PR (#8, 10 commits internally — folder moves, dedup extraction, legacy removal, the location fix, and the `/setup` revamp, each keeping `npm test` green).

## [1.1.0] — 2026-07-08

### Added
- `/schedule` now accepts `schedule.times` (array) alongside the existing single `schedule.time`, for a same-day multi-fire cadence per profile — e.g. every 2.5h through working hours via `["09:00", "11:30", "14:00", "16:30", "19:00"]`. A profile registers under every time it lists; grouping-by-time and one-launchd-job-per-time behavior is unchanged, so profiles sharing a time still run strictly sequentially over one Chrome/CDP session. Fully backward compatible with `schedule.time`-only profiles.
- `doctor.js` recycles the debug Chrome instance once it's been alive past 24h (SIGTERM, SIGKILL fallback, same on-disk profile/LinkedIn session — only the process restarts) and closes the blank "New Tab Page" every Chrome launch leaves behind, which `extract.js` never touches.
- `run_scheduled.sh` gained a second, ~5-minute heartbeat watchdog (`check_extract_started.js` + `extract_started.json`, written by `extract.js` as its literal first action) alongside the existing 45-minute timeout watchdog — catches a backgrounded/never-started `/extract` far faster than waiting out the full timeout.
- `run_scheduled.sh` retries a profile once, same slot, on a heartbeat failure or a transient API disconnect (e.g. "API Error: Connection closed mid-response") that occurred before `/extract` started — cheap insurance against a blip that isn't a real pipeline problem, without re-scraping LinkedIn.
- `run_scheduled.sh` closes the debug Chrome after all of a scheduled invocation's profiles finish, instead of leaving it idle until the next slot (as little as 2.5h away on a multi-fire schedule). Relaunched fresh next time — the LinkedIn session lives in the on-disk `.chrome-debug` profile, not the running process. Scoped to scheduled runs only; interactive `/run` still leaves Chrome open on purpose.

### Fixed
- Traced two consecutive days of failed scheduled runs to (a) a headless agent backgrounding `/extract` against `run.md`'s explicit no-backgrounding rule, hanging until the 45-min timeout, and (b) a transient Anthropic API disconnect — both addressed by the heartbeat/retry work above. Also found and fixed an unrelated resource-pressure issue found during the investigation: the debug Chrome instance was never recycled and had been alive 3 days straight (80% swap used, 56 Chrome processes on an 8GB machine) — addressed by the age-recycle and close-after-run changes above.
- Post-merge code review of the above (8 findings, all fixed): guarded a Chrome-recycle race that could crash `/doctor` outright on an unhandled `ESRCH`; anchored the transient-API retry match to the CLI's actual `^API Error:` error-line prefix so scraped job-posting text can't trigger a false-positive retry; narrowed that retry to skip cases where `/extract` had already started (avoids doubling LinkedIn scrape traffic on a late-pipeline blip) while extending it to also cover heartbeat failures (previously excluded, even though those are always cheap to retry since nothing was scraped); fixed `check_extract_started.js` hardcoding its marker path instead of resolving it through `config.js`'s `paths()` (broke in legacy mode); deduped `schedule.times` so a repeated time entry can't run a profile's pipeline twice in one slot; guarded the end-of-run Chrome close against killing a concurrent interactive session.

### Notes
- The heartbeat watchdog only guards `/extract`'s start, not the other stages in the pipeline, nor a genuine mid-stage hang — both still fall back to the full 45-minute timeout.
- No dead-man's-switch yet for the case where a scheduled job never fires at all (e.g. the machine is off); lid/sleep was investigated this session and ruled out as a live contributor (the machine was confirmed awake for both failed runs).

## [1.0.1] — 2026-07-08

### Changed
- Open-source contributor workflow: GitHub Actions CI runs the test suite on every PR, plus a PR template and contributing docs. `main` is branch-protected — PR with green `test` check required, admins included; only tags push directly.
- `/wrap ship` hardened: the version-sync chore now lands via a short `release/vX.Y.Z` PR (required by branch protection) and a mandatory three-item checklist — CHANGELOG block, `npm version --no-git-tag-version`, README version badge — closing the drift that left `package.json` at 0.7.0 through v0.8.0 and the README badge at 0.12.0 through v1.0.0. The tag is created from merged `main` HEAD, never the local branch commit.
- CLAUDE.md refreshed to match the repo: `/schedule` lane documented (headless launchd `claude -p "/run <profile>"` firings; profiles sharing a `schedule.time` run strictly sequentially on the one Chrome/CDP session — never concurrent), legacy-mode rule matched to `scripts/config.js`, "Two exceptions" wording fixed.

### Fixed
- Profile resolution: an explicit `JOBBUNNY_PROFILE` now always wins over legacy-layout detection, so profile-mode invocations — including the test suite's fixture profiles — work on a fresh clone with no `config.json`. Legacy mode is now strictly the no-signal fallback.

## [1.0.0] — 2026-07-08

### Added
- **Greenhouse API lane (channel #2)** — the v1 design version (design_v1 in Notion). A second, browser-less channel alongside LinkedIn: `/greenhouse` (`scripts/greenhouse.js`) fetches open positions for a per-profile company watchlist (`profiles/<name>/greenhouse_boards.md`, `## Curated` + `## Auto-discovered` sections) from the public keyless boards API and appends them to `jobs_raw_text.json` in the exact extract record shape with `gh-<id>` job ids — everything downstream (`compress → /structure → assemble → filter → dedup → rank → sync`) is reused untouched. Per-job gates mirror the LinkedIn lane: seen-ledger (`data/gh_seen.json` — Greenhouse has no `f_TPR`-style window, so each job is structured at most once ever), cache skip, avoid list, title filter; `GH_MAX_NEW` (default 40) caps new records per run so a big board's first fetch can't flood `/structure`. Fail-soft: a failing board is skipped (page-group pattern); a whole-lane outage notifies info-level and exits 0 — the lane can never kill `/run`.
- **Probe loop (discovery → monitoring):** `extract.js` now writes `data/companies_seen.json` (unique card companies post-avoid, including title-dropped ones); `/greenhouse` probes new names against the boards API (token guesses from `normalizeName`, ≤25/run, 300ms apart), verifies the board's own `name` matches before trusting a hit (live-caught counterexample: token `sage` belongs to "EverSurance"), auto-adds hits under `## Auto-discovered`, and records misses in `data/gh_probe_ledger.json` so they're never re-probed.
- `extractJobId()` now parses both Greenhouse URL shapes (`job-boards.greenhouse.io/<token>/jobs/<id>` and embedded `?gh_jid=<id>`) as `gh-<id>`, so a `/reconcile` cache rebuild round-trips Greenhouse job ids exactly.
- `/doctor`: `checkGreenhouse()` — absent watchlist passes ("optional — lane disabled"); malformed line is red; no live API reachability check (same rationale as the Telegram check). `.claude/commands/greenhouse.md` skill doc; `/run` stage 4 (fail-soft); CLAUDE.md + README channel notes; `templates/greenhouse_boards.md`.
- `scripts/greenhouse.test.js` (27 tests) + Greenhouse `extractJobId` cases in `util.test.js` — suite now 145.
- Watchlists seeded (all tokens probe-verified live): 16 boards for harish, 11 for uvashree.

### Notes
- Verified end-to-end live: probe drill (hit auto-added, name-mismatch rejected, avoid-listed never probed, misses ledgered), standalone lane run + idempotent re-run (`seen_skipped` exact), bogus-board fail-soft drill, then the full tail — 12 Greenhouse jobs through `/structure`/filter/dedup/rank, 4 remote roles synced to Notion with company-site Job URLs, and a reconcile round-trip preserving `gh-` ids. Title gate dropped 1,026 of ~1,040 fetched jobs pre-LLM, confirming token cost stays bounded.
- Known edge (documented in `greenhouse.md`): a run crashing between `/greenhouse` and `/sync` strands that batch behind the seen-ledger; recovery is deleting `data/gh_seen.json`.
- The Greenhouse boards API supplies title/company/location/JD but not skills/seniority/YoE, so Greenhouse jobs go through the shared `/structure` LLM stage like every other job — "no LLM" applies to fetching, not structuring.

## [0.13.0] — 2026-07-07

### Added
- Repost handling in `/dedup` (roadmap "Stale / repost handling", pulled forward from v3): LinkedIn reposts get a fresh `job_id`, so they always passed the id-keyed dedup and inserted a duplicate Notion row for a job already tracked. New `repostKey()` in `util.js` (normalized title + company + city — city included so a company posting the same title in two cities keeps both openings) and a repost drop in `dedup.js`: fresh id but known repost key → dropped and counted separately, nothing written to Notion (the existing row stands; sync stays insert-only). `dedup.js` core extracted into a pure exported `dedupJobs(jobs, cacheJobs)` (same import-safe pattern the rest of the pipeline got in 0.11.0) with new `dedup.test.js` + `repostKey` cases in `util.test.js` (114 tests total).
- Stale-lead rule in `/cleanup`: pages with **no Status at all** (never triaged — sync never writes Status, so empty means untouched) older than `CLEANUP_LEAD_DAYS_OLD` (default 30) are now listed/archived alongside the existing 7-day `Passed` rule. Any manually set Status exempts a row; dry-run by default, `--apply` unchanged; per-rule labels and counts in the output. Also added the `import.meta.url` main-guard that 0.11.0 gave every other script — `cleanup.js` was missed and still ran on import.

### Notes
- A repost still costs one JD fetch + one `/structure` row per repost event before dedup drops it (extract's pre-JD cache skip is id-based). Catching it at card level needs fuzzy card-location matching — deferred to the roadmap as a token optimization, alongside browser-driven "no longer accepting applications" detection.

## [0.12.0] — 2026-07-07

### Changed
- `rank.js` ground-up rework (roadmap "Ranking precision", long-deferred from v0.2.0): the old formula let absence-of-signal award full credit, so a job with 0/N skills matched could still hit 70 = "Kandipa podu" via seniority (+30) + home-city (+20) + null-YoE (+20) — the EPAM Solution Architect = 70 class, reproduced live with "Tech Lead – Automation Solutions (Power Platform, K2)". New 100-pt split makes relevance dominant (70 pts) over logistics (30 pts): skills overlap 40 (core ×1.0, `secondary_skills` now count ×0.5, denominator clamped to [3, 8] so 1-skill JDs can't spike and laundry-list JDs can't tank a strong core match) · title relevance 15 (new axis — `job_title` vs the profile's `filter_config.json` `title_filter.domain` keywords; neutral 8 when none configured, so legacy mode is unaffected) · seniority 15 (was 30) · work type + timezone 20 (unchanged logic) · YoE 10 (was 20; **null requirement now scores neutral 5 instead of full credit**). Hard cap: zero core-skill matches → score capped at 50, so a role that isn't ours can never reach "Kandipa podu" no matter how convenient the logistics — this cap is also the architect-title over-credit fix (a bare "Architect" structured as Staff/Lead used to collect the full seniority points with no skills relevance).
- Excitement bands reduced from five to three: ≥85 "Vera level" · 65–84 "Kandipa podu" · <65 "Try panalam" (floor catch-all). "Okay tha" and "Deal la vidu" dropped from `rank.js` and `schema.js` `EXCITEMENT_OPTIONS` (affects fresh DB creation only — existing Notion rows/options keep their values and age out via `/cleanup`).
- `rank.test.js` rewritten for the new formula (36 tests): per-axis coverage incl. denominator-clamp boundaries, secondary-skill half weight, title hit/miss/legacy-neutral, the zero-core cap (incl. secondary-only match still capped), and the new band boundaries.

## [0.11.0] — 2026-07-07

### Added
- `/setup` overhaul: turned into a single guided walkthrough instead of stopping after the Notion wiring. `scripts/init.js` gained a dependency preflight (`checkDependencies()`: Node version, package resolvability via dynamic import derived live from `package.json`, Chrome presence, and a warning if the repo sits under a macOS-protected folder like `~/Desktop`/`~/Documents`/`~/Downloads`) and now seeds `profiles/<profile>/resume.json` from `resume.example.json` (self-healing via the same empty-file check `cache.json` already used). `.claude/commands/setup.md` now walks through résumé fill-in, `/update-resume`, a new title-filter review step, first `/add-url`, optional `/notify-setup`, and a closing `/doctor` run with real pass/fail output, all in one invocation. `CHROME_BIN` is now a single shared export in `config.js` instead of being duplicated in `doctor.js`. README quick-start reframed around `/setup` as the one-command path.
- Title-filter review step: `filter_config.json`'s `title_filter` block was previously scaffolded silently from a frontend/UI-biased template with no review — a mismatch here silently drops every job ("no domain match") with no visible error. `/setup` now has an explicit step to review and tune it before continuing.
- `node:test` unit tests (91 assertions, 7 new files) for the deterministic, LLM-free pipeline core: `rank.js` (scoring), `filter.js` (location/timezone hard-drops), `title_filter.js` (title gating), `avoid.js` (avoid-list matching), `util.js` (normalization/dedup helpers), `add_url.js` (URL cleaning), and a narrow read-only slice of `config.js` (path resolution). The `title_filter`/`filter`/`config` tests use disposable fixture profiles under `profiles/` so they never read or depend on real personal profile data.

### Fixed
- `/run`: never background a stage command, even a slow one — a backgrounded stage in a headless/scheduled run (`claude -p ... --dangerously-skip-permissions`, a single-shot non-interactive call) could silently truncate the whole run right after the backgrounded stage starts, with no error and no `mark_run_result.js` call.
- `filter.js`, `dedup.js`, `generate_meta.js`, `compress.js`, `assemble.js`: were missing the `import.meta.url === file://...` guard that `rank.js`/`add_url.js` already had around their `main()` call, so importing any of them (as the new tests do) silently ran the full file-based pipeline as an unawaited side effect — surfaced as a real race (`ENOTEMPTY` on test fixture cleanup) while writing `filter.test.js`. All five now only run `main()` when invoked directly, consistent with the rest of the pipeline.

### Notes
- Removed dead `seniority_keywords`/`title_keywords`/`skills_overlap_threshold` keys from `templates/filter_config.json` and both real profiles (`harish`, `uvashree`) — leftover from a pre-`title_filter` schema (see 0.4.0/0.5.0 below); nothing reads them, only the `title_filter` block is used.

## [0.10.3] — 2026-07-06

### Fixed
- `scripts/notifiers/telegram_format.js`: the banner and an optional title were both bold text sitting directly above the body with only a blank line between them — especially hard to distinguish from the Run Summary's own bold heading. Adds a visible separator between the envelope (banner + optional title) and the body, and drops the now-redundant "Run complete" title from the success digest entirely (the Run Summary body already opens with its own heading).
- Deterministic PASS/FAIL detection: `run_scheduled.sh` relied on `grep -q "## Run Summary" "$log_file"` to detect success — a real live-tested run genuinely succeeded (jobs synced, confirmed via `cache.json`) but was reported FAILED, and fired a false "run failed" alert, because the headless agent printed a shorter completion sentence instead of the exact template. Adds `scripts/mark_run_result.js` (called explicitly by the `/run` orchestration on both its success and failure paths — a mechanical script call, not freeform prose) and `scripts/check_run_result.js` (the new deterministic check, with a staleness guard against the run's start time so a crash before ever reaching the marker doesn't reuse an old "success").
- Duplicate Telegram digest on scheduled runs: a live test showed one completed run sending two Telegram messages — one from inside the agent (per `run.md`'s own forwarding instruction) and a second from `run_scheduled.sh`'s wrapper-level forward, since neither layer knew about the other. `run_scheduled.sh` now sets `JOBBUNNY_HEADLESS=1` when invoking `claude`; `run.md`'s forwarding instructions check for it and skip their own send when set, since the wrapper will send its own digest once `claude` exits.

### Notes
- Also relocated the repo out of `~/Desktop` during today's live testing (see README Troubleshooting) — a background `launchd` job doesn't inherit the folder-access grants an interactive Terminal session has, so both `bash` and Chrome itself could get silently blocked or hang on a permission prompt with nobody there to answer it. Not a code change, but the root cause behind two of today's fixes surfacing at all.

## [0.10.2] — 2026-07-06

### Added
- `scripts/notifiers/telegram_format.js`: a proper message template for Telegram alerts — a consistent banner (severity icon + "Job Bunny" + profile name), Unicode "fake bold" for headings/labels (different codepoints, not markup — can't cause a parse/send failure the way real `parse_mode` escaping bugs could), and generic markdown-table-to-bullet-list conversion so the Run Summary's excitement-bands table renders as clean bullets instead of raw pipe/dash text. New `"success"` severity (✅, previously `"info"` was reused for this) for a clean PASSED run digest.
- `npm test` (`node --test scripts/`): `node:test`-based unit tests for `telegram_format.js`'s pure functions (bold-mapping incl. surrogate-pair correctness, table-to-bullet conversion, heading/inline-bold stripping, truncation boundary).

### Fixed
- Call-site titles (`doctor.js`, `notion_sync.js`, `extract.js`, `notify_setup.js`, `run_scheduled.sh`, `run.md`) no longer redundantly repeat `— profile X` — the new banner already carries it.

### Notes
- `sendTelegram()` falls back to the old plain-text concatenation if formatting ever throws, so this can't regress the notifier's never-throws contract — verified live via fault injection, plus two live Telegram sends (success + blocking) confirmed visually.

## [0.10.1] — 2026-07-06

### Fixed
- `scripts/run_scheduled.sh`: a hung headless `/run` (as opposed to a clean stage failure) previously blocked that profile's scheduled slot indefinitely with no alert at all, since every `notify()` hook fires on a stage *completing* with an error, never on the process simply never finishing. The script now backgrounds the `claude` invocation with a watchdog that kills it after a configurable timeout (`JOBBUNNY_RUN_TIMEOUT_SECONDS`, default 2700s/45min — neither `timeout` nor `gtimeout` ships on stock macOS, so this is a portable bash background+poll+kill watchdog instead). `set -m` + a negative-PID kill terminate the whole process group, not just the top-level `claude` PID — verified live that a single-PID kill orphans child processes (e.g. subprocesses `claude` itself spawns), while the group-kill correctly takes down the whole tree. A timeout now fires the existing FAILED-path alerts (macOS notification + Telegram) with a distinct "TIMED OUT after Ns" message.

## [0.10.0] — 2026-07-06

### Added
- Telegram notification system: `scripts/notify.js` (generic dispatcher — reads the active profile's `notify` block, fans out to enabled channels via `Promise.allSettled`, never throws) + `scripts/notifiers/telegram.js` (plain-text Telegram channel, `AbortSignal.timeout(5000)`, never throws on missing token/chat_id/non-2xx/timeout) + `/notify-setup` (`scripts/notify_setup.js`, guided BotFather + `chat_id` auto-detect flow; read-parse-merge-writes `profile.json`, never overwrites wholesale).
- Per-profile bot override: a profile can use its own separate Telegram bot instead of the shared `TELEGRAM_BOT_TOKEN` — `telegramTokenEnvKey(profileName)` resolves an optional `TELEGRAM_BOT_TOKEN_<PROFILE>` env key first, falling back to the shared one. `/notify-setup` offers this choice interactively whenever a shared token already exists; `checkNotifier()` checks whichever key applies to the active profile.
- `scripts/doctor.js`: `checkNotifier()` — passes ("optional — run /notify-setup to enable") when `notify.telegram.enabled` is false; hard-fails on missing `TELEGRAM_BOT_TOKEN` or missing `chat_id` when enabled. No live Telegram API reachability check (deliberate — a transient API blip must not hard-abort the pipeline). `/doctor` now self-notifies (`severity: "blocking"`) before exiting on any red check.
- `scripts/extract.js`: aggregate "every URL failed" detection — if 100% of this run's URLs failed (group-level and URL-level skips distinguished by presence of a `url` key), fires a blocking alert shaped like a LinkedIn-logout hint. Partial failures and legitimately quiet zero-card days do not trigger it.
- `scripts/run_scheduled.sh` + `.claude/commands/run.md`: both entrypoints now forward the run digest to Telegram after the existing macOS notification — the log's `## Run Summary` block on success, a plain failure message otherwise. The two entrypoints never double-send within a single run.

### Fixed
- `scripts/notion_sync.js`: `writeCache()` was unreachable if `pages.create()` threw mid-loop, so already-inserted jobs could be lost from the cache mirror and re-inserted as duplicate Notion rows on retry. The insert loop now writes the cache after every successful insert, wraps `pages.create()` in try/catch, breaks on first failure (a rate-limit/auth error will likely repeat), and always runs the final `cache.last_run`/`writeCache()` regardless of an early break. A failed sync now also fires a blocking Telegram alert with inserted/skipped/remaining counts and the Notion error text before re-throwing.

### Notes
- Setup is a guided skill, not manual `.env` editing — `TELEGRAM_BOT_TOKEN` is shared across profiles (same split as `NOTION_TOKEN`); per-profile `chat_id` lives in `profile.json`.
- v1 scope is intentionally narrow: final run digest + blocking mid-pipeline alerts (doctor red, Notion sync failure, LinkedIn-logout-shaped extract failure) — not a full observability firehose.

## [0.9.0] — 2026-07-06

### Added
- `/schedule` (+ `scripts/schedule.js`): generates and installs macOS launchd LaunchAgents from each profile's `schedule` config (`profile.json`: `enabled`/`time`). Profiles sharing an identical fire time are grouped into one launchd job and run strictly sequentially via `scripts/run_scheduled.sh` — never concurrently, since profiles share one Chrome/CDP session.
- `scripts/run_scheduled.sh`: the launchd entrypoint — invokes `claude -p "/run <profile>" --dangerously-skip-permissions` headlessly, logs each run to `profiles/<name>/data/logs/`, and fires a pass/fail macOS notification.
- `scripts/config.js`: `listProfiles()` export.

### Fixed
- `assemble.js`: cleans up `jobs_raw_decisions.md` after merging into `jobs_raw.json`.

### Notes
- `/run` is no longer manual-only — `run.md` updated to describe both manual and headless/scheduled triggering.
- Optional hardening for machines that sleep through the scheduled time: `sudo pmset repeat wakeorpoweron` (documented in `schedule.md`); launchd already fires a missed job once on next wake with no data loss.

## [0.8.1] — 2026-07-06

### Changed
- `README.md`: maintainer overhaul — requirements table with Claude Code as a headline dependency (the LLM stage runs inline in the agent; no separate API key), quick start that ends in `/add-url → /doctor → /run`, a maintenance-command table (`/add-url`, `/page-analyse`, `/cleanup`, `/update-resume`, `/setup`/`/migrate`), new **Configuration** (per-profile file anatomy + `JOBBUNNY_PROFILE`/`JOBBUNNY_WINDOW_HOURS` overrides) and **Troubleshooting** sections, version badge, CHANGELOG link.
- `CLAUDE.md`: restructured into task-grouped sections (Ground truths / Commands / Profiles & paths / Running stages / Writing & changing code / Notion writes / Hard guardrails) so rules cluster by the activity they constrain; added the missing `/cleanup` to the command list. All prior rules preserved verbatim in substance.

### Fixed
- `package.json`: `version` synced to the release tags — it had been stuck at `0.7.0` through the v0.8.0 release.

### Notes
- Docs-only release; no runtime code touched.

## [0.8.0] — 2026-07-05

### Added
- `/cleanup` (+ `scripts/cleanup.js`): archives Notion jobs marked `Passed` older than a configurable age threshold (`CLEANUP_DAYS_OLD`, default 7 days). Dry-run by default; read-only until `--apply`/`CLEANUP_APPLY=1`. Not part of `/run`.
- `JOBBUNNY_WINDOW_HOURS` override for `/extract`: widens the `f_TPR` search window for a single invocation (e.g. catching up after a missed daily run) without touching the stored `f_TPR=r86400` default in `search_urls.md`.

### Fixed
- `scripts/extract.js`: the same job posting could be captured multiple times in one run when overlapping keyword-search URLs (e.g. multiple frontend-title variants) all matched it, since dedup only covered a single URL's own pagination and the cross-run cache — not cross-URL duplicates within a run. Added a run-scoped `job_id` dedup pass (reported as `run_deduped` in the extract summary).

### Notes
- `/run`'s end-of-run summary is now codified as an exact markdown template (profile, URL/page-group counts, extraction funnel, top excitement bands table).
- `.claude/commands/wrap.md`: the date-mention/session-numbering log-entry rule was repeated verbatim across three modes — hoisted into one shared "Log entry formatting" section instead (doc-only, no behavior change).

## [0.7.0] — 2026-07-04

### Added
- **Multi-profile support** — run the pipeline for any profile with `/run <name>` (default from `config.json`). Each profile owns its config (`resume.json`, `resume_meta.json`, `avoid.md`, `filter_config.json`, `search_urls.md`), its own Notion page + "Job Bunny — Jobs" DB in the same workspace, and fully isolated run data (`profiles/<name>/data/` — cache + all per-run intermediates). Shared across profiles: `page_inventory/`, the Chrome debug session, and `NOTION_TOKEN`.
- `scripts/config.js`: central profile/path resolution (`JOBBUNNY_PROFILE` env → `config.json` `default_profile`), dual-mode — a checkout without `config.json` runs in **legacy mode** with the exact pre-0.7 root paths, so existing installs keep working untouched after `git pull`.
- `scripts/migrate.js` (+ `/migrate <name>`, `npm run migrate`): one-shot legacy → profiles conversion; adopts the existing Notion DB from `.env`, re-seeds anything missing from `templates/`, prints rollback steps.
- `templates/`: neutral seeds for new profiles (avoid.md, search_urls.md, filter_config.json, profile.json, cache.example.json — moved from `data/`).
- `schema.js`: `SENIORITY_OPTIONS` gains `Manager` and `Senior` (additive; existing options byte-identical) so non-engineering profiles (e.g. Customer Success) rank correctly.

### Changed
- **Home-city filter/rank is now per-profile**: `filter.js` and `rank.js` read the city from `resume_meta.json` `location` instead of the hardcoded `"chennai"` — a real fix for non-Chennai users. `filter.js` therefore now requires `resume_meta.json` (run `npm run meta`).
- `init.js` is per-profile (`node scripts/init.js <profile>`): scaffolds `profiles/<profile>/` from `templates/`, creates the profile's Notion page under "Job Bunny's List" with its own DB, writes `profiles/<profile>/profile.json`. Refuses to run on an unmigrated legacy checkout.
- All stage scripts resolve paths via `scripts/config.js` and log the active profile; slash commands accept an optional profile argument (passed as `JOBBUNNY_PROFILE=<p>` per command).
- `.env` now only needs `NOTION_TOKEN`; per-profile Notion ids live in `profiles/<name>/profile.json` (legacy checkouts still read the old env keys).

### Removed
- `avoid.md`, `search_urls.md`, `filter_config.json`, `resume_meta.json` are **no longer tracked** — personal config never ships in the repo again (templates replace them; the old contents remain in git history). **Commit/back up local edits to these files before pulling.**

### Upgrade
- Do nothing → everything keeps working in legacy mode (a one-line hint appears per run).
- Or `npm run migrate <your-name>` once, then `/run` as usual. See README "Upgrading from ≤ 0.6.x".

## [0.6.3] — 2026-07-01

### Added
- `search_urls.md`: 6 new saved searches — Staff/Lead Frontend Engineer, remote-only (`f_WT=2`), for Malaysia (`geoId=106808692`), Singapore (`geoId=102454443`), and Australia (`geoId=101452733`). geoIds verified live against LinkedIn's own location autocomplete.

### Fixed
- `page_inventory/linkedin__jobs-search.md` + `linkedin__jobs-search-results.md`: `jd_settled_signal` changed from `network-idle` to `selector-visible`. LinkedIn's long-poll/websocket traffic means `networkidle` almost never fires naturally, so every JD fetch was paying the full 4s timeout as dead time; waiting on `#job-details` becoming visible resolves in a fraction of that with no reliability loss.

### Notes
- Prior commit (`b849cc1`, already on main before this release): fixed the `linkedin__jobs-search-results` `must_exist` assertion.

## [0.6.2] — 2026-06-29

### Added
- `README.md`: public-facing overview — Mermaid pipeline diagram, stage table, setup steps, privacy note.
- `assets/job-bunny-logo.svg`: chunky pixel-art mascot (lavender bunny holding a magnifying glass) — 20×20 sprite, transparent, `crispEdges`.
- `resume.example.json` and `data/cache.example.json`: sanitized schema templates for a fresh clone.

### Changed
- `.gitignore`: now excludes `resume.json` and `data/cache.json` (real personal data, kept local-only).
- `package.json`: version bumped to match the release tag.

### Notes
- Prepared for public release: removed personal PII (contact details, work history) and the salary-band search filter from the working tree **and rewrote git history** to purge them from all prior commits — tags preserved, commit log intact. No pipeline behaviour changed.

## [0.6.1] — 2026-06-29

### Added
- `.claude/commands/page-analyse.md`: authored the missing `/page-analyse` command — referenced in 5 places (`CLAUDE.md`, `add-url.md`, `add_url.js`, `doctor.js`, `extract.js`) but never written. Browser-driven (Claude in Chrome), script-less; inspects a page-type's live DOM and writes/refreshes `page_inventory/<page>.md` in the canonical format, with a completeness gate tied to `extract.js`'s `REQUIRED_SELECTORS`.

### Fixed
- `.claude/commands/run.md`: step 5 now references `jobs_raw_decisions.md` / `jobs_raw_checkpoint.md` — stale `.json` references left over from the v0.6.0 markdown switch (the code in `assemble.js` and the `/structure` skill already used `.md`).

### Notes
- `CLAUDE.md` cleanup (no behavioural change): removed the duplicate "No LLM in ranking or filtering" guardrail (already covered by the Determinism non-negotiable), replaced the inline `/add-url` param list with a pointer to `add-url.md`, condensed the token-efficiency note, and added `/wrap` to the maintenance command list.

## [0.6.0] — 2026-06-29

### Added
- `scripts/assemble.js`: `parseDecisionsMd()` — parses the LLM's markdown table output into structured objects. 11 fixed columns; empty cell = null; `true`/`false` for booleans; semicolon-separated skills → array; `｜` unescaped to `|`. Fails loud with row number and cell count on format drift.

### Changed
- `/structure` output format: LLM now writes `jobs_raw_decisions.md` (markdown table) instead of `jobs_raw_decisions.json`. Eliminates repeated field names, brackets, and quotes — ~55% fewer output tokens per row at batch scale. Checkpoint also writes markdown (`jobs_raw_checkpoint.md`).
- `assemble.js`: reads `jobs_raw_decisions.md`; JSON parse replaced by `parseDecisionsMd()`.
- `fixtures/structure_example.md`: updated to show markdown input → markdown output worked example.
- `.gitignore`: added `jobs_raw_decisions.md` and `jobs_raw_checkpoint.md`.
- `CLAUDE.md`: updated output filename reference and token efficiency note.

## [0.5.0] — 2026-06-29

### Added
- `scripts/doctor.js`: auto-launches Chrome with `--remote-debugging-port=9222` using persistent profile at `.chrome-debug/` when CDP is unreachable; polls up to 10 s before failing. Login to LinkedIn once — session persists across runs. No manual Chrome start needed.
- `search_urls.md`: expanded from 5 → 13 targeted search URLs. New queries: `Staff React Engineer`, `Lead UI Engineer`, `Principal React Engineer` (India remote); `Staff Frontend Engineer`, `Lead Frontend Engineer`, `Principal Frontend Engineer` (Chennai on-site+hybrid); `Staff Frontend Engineer` and `Lead Frontend Engineer` (India remote). Replaces broad `Lead Software Engineer` (267 title-drops, 0 captures per run) and noisy `Frontend Architect` URLs.

### Changed
- `search_urls.md`: stripped `f_SAL` salary filter from Banks and Staff FE search-results URLs — salary gate was suppressing results (Banks consistently returning 0; Staff FE unnecessarily filtered).
- `.gitignore`: added `.chrome-debug/` (persistent browser profile, local-only); added all pipeline intermediate files (`jobs_raw_decisions.json`, `jobs_raw_checkpoint.json`, `structure_input.md`, `structure_passthrough.json`) — these are regenerated each run and were showing as untracked noise.
- `CLAUDE.md`: documented Chrome auto-launch behaviour so future sessions know not to ask the user to start Chrome manually.

## [0.4.1] — 2026-06-27

### Changed
- `extract.js`: new `stageFilter(cards, pred, msgFn, summaryKey, summary)` helper eliminates 3 duplicated before/after/log blocks (avoid, cache-skip, title-filter); `DEBUG` and `CARD_CAP` hoisted to module-level constants (was double-parsed from `process.env` per call); card field reads parallelised with `Promise.all` (5 attributes per card, all at once); cap now applied after all pre-filters (was before title gate — ordering gap); `title_dropped` counter added to run summary; per-card DROP logs gated behind `DEBUG` env var; dead `selector-visible` case removed from `waitSettled` switch; redundant post-loop `writeFile` removed (incremental flush inside URL loop is sufficient); `captureJd` takes explicit `cap` param computed once per group (not re-read per card via `jdCap(cfg)` each time).
- `compress.js`: retired `PREFILTER_PATTERNS` / `passesPreFilter` — Stage A already gates by title in `extract.js`; a second divergent hardcoded filter was a maintenance hazard with no added value.

## [0.4.0] — 2026-06-27

### Added
- `scripts/title_filter.js`: universal config-driven title gate; exports `filterByTitle(title) → { pass, reason }`. Evaluation order: `function.block` (hard drop) → `seniority` → `domain`; multi-word terms matched as full phrases, longest-first. Regexes compiled once at module load. `function.allow` is informational only (appears in pass-reason string, not a gate).
- `filter_config.json`: new `title_filter` key with `seniority`, `domain`, and `function.allow/block` lists — title tuning no longer requires code edits in any script.

### Changed
- `extract.js` (Stage A): title filter wired after cache-skip and card cap; non-matching titles (non-engineering roles, blocked functions) now dropped before any JD tab is opened — eliminates browser navigation + jitter cost for irrelevant cards.
- `filter.js` (Stage B): title gate replaced by `filterByTitle()` call; old seniority/title_keywords/skills-fallback logic and `resume_meta.json` dependency removed.

## [0.3.0] — 2026-06-26

### Added
- `compress.js`: pre-LLM stage that pre-filters `jobs_raw_text.json` by card title (role words + frontend signal keywords), sanitises `raw_text`, and emits a compact markdown table (`structure_input.md`) + `structure_passthrough.json`. Cuts `/structure` token input by ~55–60%.
- `assemble.js`: post-LLM stage that merges `jobs_raw_decisions.json` (LLM-only fields) with `structure_passthrough.json` → `jobs_raw.json`. Fails loud on missing required fields per CLAUDE.md "fail loud" rule.
- `/structure` skill: reads `structure_input.md`; writes `jobs_raw_decisions.json` (LLM fields only); checkpoints every 25 rows to `jobs_raw_checkpoint.json` for context-compaction recovery; resumes from checkpoint if present.
- `/run` pipeline expanded 8 → 10 steps (compress at step 4, assemble at step 6).
- `extract.js`: `newPage()` helper with transparent CDP reconnect on context-closed errors.

### Fixed
- `compress.js`: escape `|` in `card_title`, `card_company`, `card_location` before table interpolation; real-world titles like `"Frontend Developer - Fully Remote | Upto $85/hr"` were splitting the markdown column.
- `compress.js`: skip cards with null `job_id` early to prevent `"null"` string landing in the table and aborting `assemble.js`.
- `compress.js` / `assemble.js`: parallel `Promise.all` for file I/O (was sequential).
- `filter_config.json`: lower `skills_overlap_threshold` 3 → 2; previous threshold was too strict (4 of 208 jobs passing; 2 correctly includes near-miss frontend roles).

## [0.2.4] — 2026-06-24

### Fixed
- `extract.js`: skip jobs already in `cache.json` before opening JD pages; builds a Set of known `job_id`s at startup and filters cards pre-`captureJd()` — redundant browser navigation eliminated on re-runs.
- `extract.js`: move `EXTRACT_MAX_CARDS` cap to after the cache filter so it limits genuinely-new cards only (previously cap consumed slots occupied by cached jobs, leaving fewer new captures than intended).
- `extract.js`: count `summary.cards` after all filters so the final log line reflects JD-fetch candidates; `cards ≈ captured` in the summary.
- `extract.js`: log `cache.last_run` timestamp alongside known-ID count so stale-cache standalone re-runs are immediately visible.
- `extract.js`: add explicit `import "dotenv/config"` (previously pulled in as a hidden side effect via `cache.js`).
- `cache.js`: `readCache()` now warns on corrupt/unreadable `cache.json`; `ENOENT` (fresh install / missing file) stays silent.

## [0.2.3] — 2026-06-24

### Fixed
- `/wrap` command: use `<mention-date start="YYYY-MM-DD"/>` (Notion MCP enhanced-markdown) for log entry headings instead of `@today` / `@YYYY-MM-DD`, which were landing as plain text rather than Notion date mentions.

## [0.2.2] — 2026-06-24

### Fixed
- `add_url.js`: strip `start` pagination param so saved URLs always open at page 0; remove erroneous `/jobs/search-results/` → `/jobs/search/` path rewrite.
- `extract.js`: implement URL-based pagination (`start=0,25,50…`) driven by inventory `pagination_type: url-pages`; fixes LinkedIn extraction stopping at page 1.
- `extract.js`: per-card dedup via imperative loop; fixes same-page duplicate IDs passing dedup when filter+forEach ran before Set was updated.
- `extract.js`: `:nth(N)` selector notation for pages with hashed CSS class names; `innerText()` + first-non-empty-line suppresses badge and a11y duplicate text in card fields.
- `add_url.js`: `/jobs/search-results/` and `/jobs/search/` now map to separate page types (`linkedin__jobs-search-results` vs `linkedin__jobs-search`); each has its own inventory.

### Added
- `page_inventory/linkedin__jobs-search-results.md`: live DOM inventory for the `search-results` route (componentkey attr, `:nth(N)` selectors).

## [0.2.1] — 2026-06-22

### Fixed
- `/wrap ship` now updates the "Active version" column in the Design Versions table on every bump (minor and patch), not just on major bumps.

### Notes
- `data/cache.json` refreshed to reflect post-v0.2.0 filter run state.

## [0.2.0] — 2026-06-22

### Added
- Stage B title gate in `filter.js`: 4-step short-circuit filter (seniority gate → title check → skills fallback → default drop). Drops non-frontend noise (architects, PMs, backend/analyst roles) that previously reached the Notion DB.
- `filter_config.json`: config-driven keyword lists (`seniority_keywords`, `title_keywords`, `skills_overlap_threshold`) — filter tuning no longer requires code edits.

### Notes
- `"architect"` treated as a seniority tier, making the old architect shortcut redundant and simplifying the gate to 4 steps.
- Word-boundary regex (`\bui\b`) guards against false matches on substrings like "fluid", "equity".

## [0.1.2] — 2026-06-21

### Fixed
- `/wrap` log format: use Notion date mentions (`@today`) for inline date rendering.
- `run.md` + `CLAUDE.md`: clarified `/doctor` and `/structure` behavior.

## [0.1.1] — 2026-06-21

### Added
- `/wrap` command: session close-out for design, log, improve, and ship modes.
- `/reconcile` stage: rebuilds job pipeline state from the live Notion DB
  (Notion = source of truth).

## [Unreleased]

Hardening increments (see roadmap): `0.3.0` ranking precision · `0.4.0` deterministic
structuring · `0.5.0` extraction token efficiency.

## [0.1.0] — 2026-06-18

First working milestone of the v0 LinkedIn lane — full pipeline verified live
(extract → structure → filter → dedup → rank → sync; 16 jobs synced).

### Added
- Config-driven Playwright-over-CDP extractor (`extract.js`): new-page JD capture via
  the stable "About the job" text anchor, reused JD tab, 2500-char trim, Stage A
  avoid-drop, per-URL/per-card resilience, incremental flush.
- `init.js` + shared `schema.js` (byte-exact Notion selects), `generate_meta.js`,
  `cache.js` reconcile (Notion = source of truth), `filter.js`, `dedup.js`, `rank.js`,
  `notion_sync.js` (automated fields only, idempotent).
- Slash commands (`/run` + stages + maintenance), `CLAUDE.md` run-time contract.
- `/add-url` URL cleaning (ephemeral strip, stale `f_TPR` anchor drop,
  `search-results` → `search` canonicalization).

### Notes
- Known determinism/token gaps tracked as `0.2.0`–`0.5.0` in the roadmap.
