# Changelog

Versions follow the v0 LinkedIn-lane code semver (`0.x.y`); the forward-looking
feature→version map lives in the [Notion roadmap](https://app.notion.com/p/381cbef64ec281d1b3a5ebd4f3d0fd1e).

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
