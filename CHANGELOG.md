# Changelog

Versions follow the v0 LinkedIn-lane code semver (`0.x.y`); the forward-looking
feature→version map lives in the [Notion roadmap](https://app.notion.com/p/381cbef64ec281d1b3a5ebd4f3d0fd1e).

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
