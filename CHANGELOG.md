# Changelog

Versions follow the v0 LinkedIn-lane code semver (`0.x.y`); the forward-looking
feature→version map lives in the [Notion roadmap](https://app.notion.com/p/381cbef64ec281d1b3a5ebd4f3d0fd1e).

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
