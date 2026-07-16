# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Job Bunny aggregates LinkedIn jobs daily, filters/ranks them against a profile, and syncs to Notion. The pipeline is driven by **slash commands, not this file** — `/run` owns the canonical stage sequence; treat this file as the invariants those commands operate under.

## Architecture

`scripts/` is organized by domain, not by pipeline stage:

- `lib/` — shared plumbing every stage imports: `config.js` (profile/path resolution — the only module that knows the on-disk layout), `util.js`, `io.js` (JSON read/write), `cli.js` (run-guard + `--flag value` parsing), `env_file.js` / `prompt.js` (readline helpers), `browser.js` (Chrome/CDP lifecycle), `page_actions.js` (humanized page interaction), `run_log.js` (checkpoint logger).
- `pipeline/` — the deterministic stages, run in sequence by `/run`: `extract → greenhouse/keka (optional) → compress → [structure, LLM] → assemble → filter → dedup → rank`. Each stage is explicit-input-file → explicit-output-file (see Writing & changing code). `extract` is `extract.js` (thin orchestrator) + `scripts/pipeline/extract/` (`parse.js`/`state.js`/`filters.js` pure; `cards.js`/`jd.js` browser-driving).
- `notion/` — `schema.js` (byte-exact select options), `cache.js` (`/reconcile`), `notion_sync.js` (`/sync`), `cleanup.js`.
- `notify/` — best-effort dispatcher (`notify.js`) + connectors (`telegram.js`).
- `ops/` — machine/process orchestration: `doctor.js`, `schedule.js` + `run_scheduled.sh`, `release.js` (release mechanics — see Writing & changing code).
- `setup/` — onboarding: `init.js`, `notify_setup.js`, `generate_meta.js`, `add_url.js`.

`.claude/commands/*.md` are the slash-command definitions — most are thin one-stage wrappers around a single `scripts/<domain>/<x>.js`; `/run`/`run.md` owns orchestration across the full sequence.

## Ground truths

- **Notion is the source of truth.** The profile's `cache.json` is a perf mirror only, rebuilt from Notion at the start of every run (`/reconcile`). Never treat the cache as authoritative.
- **The only runtime LLM stage is `/structure`** (raw JD text → structured records). Filtering, dedup, and ranking are pure deterministic JS — never move their logic behind an LLM.
- **The design doc (design_v0) lives in Notion** and is build-time reference only: fetch it on demand when authoring/changing code, never in the run path.
- **Surface before implement.** When a spec detail is ambiguous, stop and ask — don't guess a heuristic into existence.
- **Notifications are best-effort.** `scripts/notify/notify.js` and its connectors (e.g. `scripts/notify/telegram.js`) must never throw in a way that breaks the calling pipeline stage — a notification failure is never a reason to fail `/doctor`, `/extract`, or `/sync`.

## Commands

- `/run [profile]` — full pipeline, manual. No argument = `config.json` `default_profile`.
- Stage commands (standalone for re-run/debug, same optional profile argument): `/doctor · /reconcile · /extract · /greenhouse · /keka · /structure · /filter · /dedup · /rank · /sync`.
- Setup & maintenance: `/setup <profile> · /page-analyse · /add-url · /cleanup · /update-resume · /notify-setup · /schedule · /wrap`. `/schedule` takes no profile argument — it always reads every profile (grouping crosses profile boundaries).

Most stages are thin `node scripts/<x>.js` wrappers. Special cases:

- **`/structure` is a skill, no script** — the agent does the LLM work inline. Bookend scripts flank it: `compress.js` (`jobs_raw_text.json` → `structure_input.md`, a pre-filtered compact markdown table) before; `assemble.js` (LLM output `jobs_raw_decisions.md` + `structure_passthrough.json` → `jobs_raw.json`) after.
- **`/page-analyse` is browser-driven** (Claude in Chrome), script-less.
- **`/greenhouse` and `/keka` are optional second channels**: keyless ATS APIs (Greenhouse boards; Keka careers), watchlists at the profile's `greenhouse_boards.md`/`keka_boards.md`, merging into `jobs_raw_text.json` ahead of `/structure`. Fail-soft — an absent watchlist or a whole-lane outage exits 0, never stops `/run`.

## Development

- `npm test` — the full suite (`node --test scripts/`, Node's built-in test runner, recursive).
- Run a single test file: `node --test scripts/ops/release.test.js` (or any other `*.test.js`).
- Tests are colocated next to the module they cover (e.g. `dedup.js` → `dedup.test.js`). Pure/exported functions are unit-tested; `main()` orchestration (file I/O, `execFileSync` shell-outs) is deliberately not — see any `pipeline/*.js` or `ops/release.js` for the pattern.
- No lint or build step is configured.

## Profiles & paths

- Each persona lives in `profiles/<name>/`: resume, resume_meta, `avoid.md`, `filter_config.json`, `search_urls.md`, `profile.json` (its own Notion page + DB ids), and `data/` (cache + per-run intermediates).
- Resolution: `JOBBUNNY_PROFILE` env var → `config.json` `default_profile`. **`scripts/lib/config.js` is the only module that knows the layout** — resolve every path through it.
- **Profiles-only layout.** Legacy mode (pre-v0.7 root paths, env Notion ids) was removed in v1.2; no `config.json` and no explicit `JOBBUNNY_PROFILE` fails loud pointing at `/setup`.
- Shared across profiles: `page_inventory/`, `.chrome-debug/` (one Chrome/LinkedIn session — never copy account-personalized URLs like the *Recommended* collection between profiles), `templates/`, and `NOTION_TOKEN` in `.env`.

## Running stages

- **Pass the profile as an env prefix per command** (`JOBBUNNY_PROFILE=<p> node scripts/<x>.js`). Each bash call is a fresh shell — repeat the prefix every time; never rely on `export`. Scripts never take a profile argv.
- **Chrome for `/extract`:** `/doctor` still preflights Chrome (launch + CDP check via `scripts/lib/browser.js`), but `extract.js` now owns the lifecycle end-to-end — it ensures Chrome itself if missing and always kills it on exit (any exit path) unless `JOBBUNNY_KEEP_BROWSER=1`. LinkedIn login persists across runs in the on-disk `.chrome-debug/` profile. Never tell the user to launch Chrome manually.
- **DOM drift is a config fix, not a code fix.** `extract.js` reads selectors/behavior from `page_inventory/<page>.md` at runtime — repair breakage by editing the inventory (via `/page-analyse`), not by regenerating code.
- **Scheduled runs never overlap.** `/schedule` installs launchd jobs that fire `claude -p "/run <profile>"` headlessly; profiles sharing a `schedule.time` run strictly sequentially inside `run_scheduled.sh` because they share the one Chrome/CDP session. Never introduce concurrent `/run`s.

## Code quality principles

Consult these before writing or architecting anything — they apply to every line of code, not just the repo-specific rules below. This codebase is read and edited by other people; optimizing for "it works" alone is not acceptable.

- **Design before typing.** Before writing code, read the neighboring code and `scripts/lib/` for existing utilities; state (to yourself or the user) the shape of the change — inputs, outputs, where it lives — before implementing it. Reuse beats reimplementation, always.
- **Simplest complete solution.** The smallest design that fully solves the problem wins. No speculative generality, no config knobs "for later", no abstraction until a second concrete caller exists (YAGNI). If a function needs a comment to explain *what* it does, restructure it instead.
- **One home per concern.** Follow the domain layout (`lib/` shared, `pipeline/` stages, `notion/`, `notify/`, `ops/`, `setup/`). New logic goes where a future reader would look for it — never inline a second copy of something `lib/` already owns.
- **Write for the next editor, not this ticket.** Names say what things are; functions are small and single-purpose; pure logic is separated from I/O orchestration (this is also what makes it testable — see the existing `main()`-vs-exported-functions pattern). Assume the next person editing this has no memory of this conversation.
- **Think beyond one point of view.** Before settling on a design, check it against: other callers of the touched code, other profiles, the scheduled/headless path, and failure modes (missing file, empty input, network down). A fix that works only for the case at hand is not done.
- **Consistency over preference.** Match the file's existing idioms — naming, error style, CLI parsing via `lib/cli.js`, JSON I/O via `lib/io.js` — even when you'd personally choose differently.
- **Markdown is code here — write it with surgical precision.** This repo's `.md` files (`CLAUDE.md`, `.claude/commands/*.md`, `page_inventory/*.md`, profile docs) are LLM instructions loaded into context: every line costs tokens and dilutes attention. State each rule once, in the fewest words that remove ambiguity — no filler, no hedging, no restating what code or another doc already says. When editing, prefer tightening an existing line over adding a new one; bloat compounds.

**After coding — mandatory before any PR that touches product code:** run `npm test`, then `/simplify` (reuse/simplification/efficiency pass on the changed code), then `/verify` (exercise the change end-to-end). For larger changes, also run `/code-review`. Do not open the PR until all pass clean. Doc-only and `release.js` version-sync PRs need only `npm test`.

## Writing & changing code

- **`main` is protected — branch + PR, no exceptions.** All work (features and the `/wrap ship` version-sync chore alike) branches off `main` (`feat/<slug>`, `fix/<slug>`, `release/vX.Y.Z`, …) and lands via a pull request with the `test` check green. Nothing pushes to `main` directly — enforced for admins too; only tags are pushed straight (`git push origin vX.Y.Z`).
- **`/wrap ship`'s mechanics are owned by `scripts/ops/release.js`**, not freeform `git`/`gh` commands: preflight (clean tree, tag doesn't already exist, `CHANGELOG.md` has a dated block for the target version) → version-sync → release branch/PR → checks → a merge-confirmation pause (never unconditional auto-merge) → tag only after confirming the merged commit is reachable from `origin/main` (avoids tagging a pre-squash orphan commit). Idempotent — re-running after any failure resumes from wherever it left off. Its merge-confirmation prompt needs live stdin, so never run it backgrounded/detached.
- **Every script:** explicit input file → explicit output file, idempotent, fail loud on missing input — never silent-skip.
- **Token efficiency is a design constraint on the `/structure` path.** Stage A drops avoid-list companies on card data before JDs are opened; `compress.js` pre-filters by card title and emits a compact markdown table; `/structure` outputs a markdown table too (`jobs_raw_decisions.md`), not JSON. Preserve this shape — it roughly halves the stage's token cost.
- **Avoid-list matching** normalizes both sides: lowercase, strip legal suffixes, apply the alias map (see the profile's `avoid.md`).
- **`resume_meta.json`'s `location`** is a string (one home city) or an array of strings (multiple home cities) — never assume a bare string. Use `homeLocations()`/`isHomeCity()` from `scripts/lib/util.js` for any home-city check; don't re-implement the comparison.
- **`/add-url` cleans URLs** before filing them under their Channel → page node: strips ephemeral tracking/pagination params, drops stale absolute `f_TPR=a<epoch>-` anchors (keeps relative `r<sec>`), keeps stable filter params, preserves the path as-is. Exact param list: `add-url.md`.

## Notion writes

- **Select option strings are byte-exact** (`scripts/notion/schema.js`). Changing one without updating the existing Notion options makes sync throw.
- `notion_sync` writes **automated fields only** — manual tracking fields (Status, Notes, …) are never touched. Inserts/anchored updates only; never whole-page overwrite or delete.
- Design docs in Notion: append or anchored-replace only; never blind-overwrite.

## Hard guardrails

- No PDF parsing in the daily path — `resume.json` is the hand-maintained source of truth; PDF→JSON is a one-time `/setup` seed only.
