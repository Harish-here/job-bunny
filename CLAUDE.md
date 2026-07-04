# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Orientation

Job Bunny aggregates LinkedIn jobs daily, filters/ranks them against your profile, and syncs to Notion. **Notion is the source of truth**; the profile's `cache.json` is only a perf mirror, rebuilt from Notion at the start of every run. The design lives in Notion (design_v0) and is **build-time reference only** — fetch it on demand when authoring/changing code, never in the run path.

**Profiles (v0.7+).** Each person/persona is a profile in `profiles/<name>/` (resume, resume_meta, avoid.md, filter_config.json, search_urls.md, profile.json with its own Notion page + DB ids, and `data/` for cache + per-run intermediates). Resolution: `JOBBUNNY_PROFILE` env var → `config.json` `default_profile`; `scripts/config.js` is the only module that knows the layout. A checkout **without** `config.json` runs in legacy mode (pre-v0.7 root paths, env Notion ids) — convert with `/migrate <name>`. Shared across profiles: `page_inventory/`, `.chrome-debug/` (one Chrome/LinkedIn session — never copy account-personalized URLs like the Recommended collection between profiles), `templates/` (seeds for new profiles), and `NOTION_TOKEN` in `.env`.

## Commands

The pipeline is driven by slash commands, not by reading steps from here.

- **`/run [profile]`** — full pipeline, manual. The canonical stage sequence lives there. No argument = `config.json` default profile.
- Stage commands (also standalone for re-run/debug, same optional profile argument): `/doctor · /reconcile · /extract · /structure · /filter · /dedup · /rank · /sync`.
- Setup & maintenance: `/setup <profile> · /migrate <name> · /page-analyse · /add-url · /update-resume · /wrap`.

Most stages are thin `node scripts/<x>.js` wrappers. `/structure` and `/page-analyse` are the exceptions: `/structure` invokes the `/structure` skill (no script file — the skill does the LLM work directly); `/page-analyse` is browser-driven (Claude in Chrome). Two bookend scripts flank `/structure`: `compress.js` converts `jobs_raw_text.json` → `structure_input.md` (compact markdown table, pre-filtered) before the LLM; `assemble.js` merges the LLM output (`jobs_raw_decisions.md`) with pass-through fields (`structure_passthrough.json`) → `jobs_raw.json` after.

## Non-negotiables

- **Determinism.** Filtering, dedup, and ranking are pure JS. The **only** runtime LLM stage is `/structure` (raw text → `jobs_raw.json`). Never put ranking or filtering logic behind an LLM.
- **Surface before implement.** When a spec detail is ambiguous, stop and ask — don't guess a heuristic into existence.
- **Token efficiency.** Stage A drops avoid-list companies on card data before JDs are opened. `compress.js` further pre-filters by card title (role + frontend signal keywords) and emits a compact markdown table (`structure_input.md`), stripping pass-through fields the LLM never reads. `/structure` output is also a markdown table (`jobs_raw_decisions.md`), not JSON. Both replace repeated field names/brackets/quotes with table rows, roughly halving `/structure` token cost vs. JSON.

## Operational rules

- **Avoid-list matching** normalizes both sides: lowercase, strip legal suffixes, apply the alias map (see the profile's `avoid.md`).
- **Slash commands pass the profile as an env prefix** (`JOBBUNNY_PROFILE=<p> node scripts/<x>.js`) — each bash call is a fresh shell, so repeat the prefix per command; never rely on `export`. Scripts never take a profile argv.
- **`/add-url` cleans URLs** before filing them under their Channel → page node: it strips ephemeral tracking/pagination params, drops stale absolute `f_TPR=a<epoch>-` anchors (keeps relative `r<sec>`), keeps the stable filter params, and preserves the path as-is (`/jobs/search-results/` and `/jobs/search/` both work with the extractor). See `add-url.md` for the exact param list.
- **Chrome for `/extract`** — `/doctor` auto-launches Chrome with `--remote-debugging-port=9222` using the persistent profile at `.chrome-debug/` (gitignored). Login to LinkedIn once; the session is reused across runs. Do not tell the user to launch Chrome manually.
- **extract.js is config-driven** — it reads selectors/behavior from `page_inventory/<page>.md` at runtime. DOM drift is fixed by editing the inventory, not by regenerating code.
- **Notion select strings are byte-exact** (`scripts/schema.js`). Changing one without updating existing Notion options makes sync throw.
- **Every script:** explicit input file → explicit output file, idempotent, fail loud on missing input — never silent-skip.

## Guardrails

- No PDF parsing in the daily path — `resume.json` is the hand-maintained source of truth; PDF→JSON is a one-time `/setup` seed only.
- `notion_sync` writes **automated fields only**; manual tracking fields (Status, Notes, etc.) are never touched. Inserts/anchored updates only — never whole-page overwrite or delete.
- When updating Notion design docs, append or anchored-replace only; never blind-overwrite.
