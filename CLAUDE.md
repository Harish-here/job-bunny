# CLAUDE.md

Job Bunny aggregates LinkedIn jobs daily, filters/ranks them against a profile, and syncs to Notion. The pipeline is driven by **slash commands, not this file** — `/run` owns the canonical stage sequence; treat this file as the invariants those commands operate under.

## Ground truths

- **Notion is the source of truth.** The profile's `cache.json` is a perf mirror only, rebuilt from Notion at the start of every run (`/reconcile`). Never treat the cache as authoritative.
- **The only runtime LLM stage is `/structure`** (raw JD text → structured records). Filtering, dedup, and ranking are pure deterministic JS — never move their logic behind an LLM.
- **The design doc (design_v0) lives in Notion** and is build-time reference only: fetch it on demand when authoring/changing code, never in the run path.
- **Surface before implement.** When a spec detail is ambiguous, stop and ask — don't guess a heuristic into existence.

## Commands

- `/run [profile]` — full pipeline, manual. No argument = `config.json` `default_profile`.
- Stage commands (standalone for re-run/debug, same optional profile argument): `/doctor · /reconcile · /extract · /structure · /filter · /dedup · /rank · /sync`.
- Setup & maintenance: `/setup <profile> · /migrate <name> · /page-analyse · /add-url · /cleanup · /update-resume · /wrap`.

Most stages are thin `node scripts/<x>.js` wrappers. Two exceptions:

- **`/structure` is a skill, no script** — the agent does the LLM work inline. Bookend scripts flank it: `compress.js` (`jobs_raw_text.json` → `structure_input.md`, a pre-filtered compact markdown table) before; `assemble.js` (LLM output `jobs_raw_decisions.md` + `structure_passthrough.json` → `jobs_raw.json`) after.
- **`/page-analyse` is browser-driven** (Claude in Chrome), script-less.

## Profiles & paths (v0.7+)

- Each persona lives in `profiles/<name>/`: resume, resume_meta, `avoid.md`, `filter_config.json`, `search_urls.md`, `profile.json` (its own Notion page + DB ids), and `data/` (cache + per-run intermediates).
- Resolution: `JOBBUNNY_PROFILE` env var → `config.json` `default_profile`. **`scripts/config.js` is the only module that knows the layout** — resolve every path through it.
- No `config.json` = **legacy mode** (pre-v0.7 root paths, env Notion ids). Keep legacy mode working; `/migrate <name>` is the opt-in conversion.
- Shared across profiles: `page_inventory/`, `.chrome-debug/` (one Chrome/LinkedIn session — never copy account-personalized URLs like the *Recommended* collection between profiles), `templates/`, and `NOTION_TOKEN` in `.env`.

## Running stages

- **Pass the profile as an env prefix per command** (`JOBBUNNY_PROFILE=<p> node scripts/<x>.js`). Each bash call is a fresh shell — repeat the prefix every time; never rely on `export`. Scripts never take a profile argv.
- **Chrome for `/extract`:** `/doctor` auto-launches Chrome with `--remote-debugging-port=9222` on the persistent `.chrome-debug/` profile (gitignored). LinkedIn login persists across runs. Never tell the user to launch Chrome manually.
- **DOM drift is a config fix, not a code fix.** `extract.js` reads selectors/behavior from `page_inventory/<page>.md` at runtime — repair breakage by editing the inventory (via `/page-analyse`), not by regenerating code.

## Writing & changing code

- **Every script:** explicit input file → explicit output file, idempotent, fail loud on missing input — never silent-skip.
- **Token efficiency is a design constraint on the `/structure` path.** Stage A drops avoid-list companies on card data before JDs are opened; `compress.js` pre-filters by card title and emits a compact markdown table; `/structure` outputs a markdown table too (`jobs_raw_decisions.md`), not JSON. Preserve this shape — it roughly halves the stage's token cost.
- **Avoid-list matching** normalizes both sides: lowercase, strip legal suffixes, apply the alias map (see the profile's `avoid.md`).
- **`/add-url` cleans URLs** before filing them under their Channel → page node: strips ephemeral tracking/pagination params, drops stale absolute `f_TPR=a<epoch>-` anchors (keeps relative `r<sec>`), keeps stable filter params, preserves the path as-is. Exact param list: `add-url.md`.

## Notion writes

- **Select option strings are byte-exact** (`scripts/schema.js`). Changing one without updating the existing Notion options makes sync throw.
- `notion_sync` writes **automated fields only** — manual tracking fields (Status, Notes, …) are never touched. Inserts/anchored updates only; never whole-page overwrite or delete.
- Design docs in Notion: append or anchored-replace only; never blind-overwrite.

## Hard guardrails

- No PDF parsing in the daily path — `resume.json` is the hand-maintained source of truth; PDF→JSON is a one-time `/setup` seed only.
