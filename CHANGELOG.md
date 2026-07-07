# Changelog

Versions follow the v0 LinkedIn-lane code semver (`0.x.y`); the forward-looking
feature→version map lives in the [Notion roadmap](https://app.notion.com/p/381cbef64ec281d1b3a5ebd4f3d0fd1e).

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
