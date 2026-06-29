# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Orientation

Job Bunny aggregates LinkedIn jobs daily, filters/ranks them against your profile, and syncs to Notion. **Notion is the source of truth**; `data/cache.json` is only a perf mirror, rebuilt from Notion at the start of every run. The design lives in Notion (design_v0) and is **build-time reference only** — fetch it on demand when authoring/changing code, never in the run path.

## Commands

The pipeline is driven by slash commands, not by reading steps from here.

- **`/run`** — full pipeline, manual. The canonical stage sequence lives there.
- Stage commands (also standalone for re-run/debug): `/doctor · /reconcile · /extract · /structure · /filter · /dedup · /rank · /sync`.
- Setup & maintenance: `/setup · /page-analyse · /add-url · /update-resume · /wrap`.

Most stages are thin `node scripts/<x>.js` wrappers. `/structure` and `/page-analyse` are the exceptions: `/structure` invokes the `/structure` skill (no script file — the skill does the LLM work directly); `/page-analyse` is browser-driven (Claude in Chrome). Two bookend scripts flank `/structure`: `compress.js` converts `jobs_raw_text.json` → `structure_input.md` (compact markdown table, pre-filtered) before the LLM; `assemble.js` merges the LLM output (`jobs_raw_decisions.md`) with pass-through fields (`structure_passthrough.json`) → `jobs_raw.json` after.

## Non-negotiables

- **Determinism.** Filtering, dedup, and ranking are pure JS. The **only** runtime LLM stage is `/structure` (raw text → `jobs_raw.json`). Never put ranking or filtering logic behind an LLM.
- **Surface before implement.** When a spec detail is ambiguous, stop and ask — don't guess a heuristic into existence.
- **Token efficiency.** Stage A drops avoid-list companies on card data before JDs are opened. `compress.js` further pre-filters by card title (role + frontend signal keywords) and emits a compact markdown table (`structure_input.md`), stripping pass-through fields the LLM never reads. `/structure` output is also a markdown table (`jobs_raw_decisions.md`), not JSON. Both replace repeated field names/brackets/quotes with table rows, roughly halving `/structure` token cost vs. JSON.

## Operational rules

- **Avoid-list matching** normalizes both sides: lowercase, strip legal suffixes, apply the alias map (see `avoid.md`).
- **`/add-url` cleans URLs** before filing them under their Channel → page node: it strips ephemeral tracking/pagination params, drops stale absolute `f_TPR=a<epoch>-` anchors (keeps relative `r<sec>`), keeps the stable filter params, and preserves the path as-is (`/jobs/search-results/` and `/jobs/search/` both work with the extractor). See `add-url.md` for the exact param list.
- **Chrome for `/extract`** — `/doctor` auto-launches Chrome with `--remote-debugging-port=9222` using the persistent profile at `.chrome-debug/` (gitignored). Login to LinkedIn once; the session is reused across runs. Do not tell the user to launch Chrome manually.
- **extract.js is config-driven** — it reads selectors/behavior from `page_inventory/<page>.md` at runtime. DOM drift is fixed by editing the inventory, not by regenerating code.
- **Notion select strings are byte-exact** (`scripts/schema.js`). Changing one without updating existing Notion options makes sync throw.
- **Every script:** explicit input file → explicit output file, idempotent, fail loud on missing input — never silent-skip.

## Guardrails

- No PDF parsing in the daily path — `resume.json` is the hand-maintained source of truth; PDF→JSON is a one-time `/setup` seed only.
- `notion_sync` writes **automated fields only**; manual tracking fields (Status, Notes, etc.) are never touched. Inserts/anchored updates only — never whole-page overwrite or delete.
- When updating Notion design docs, append or anchored-replace only; never blind-overwrite.
