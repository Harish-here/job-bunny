# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Job Bunny is a personal job-search pipeline: it scrapes LinkedIn job searches with Playwright over Chrome CDP, pulls extra postings from keyless ATS APIs (Greenhouse, Keka), structures/filters/ranks them against a user's resume profile, and syncs the results to a per-profile Notion database, with optional Telegram digests. macOS only (launchd scheduling, hardcoded Chrome path).

## Rewrite status

The v0→v2 rewrite is complete and cut over: `scripts/`, `templates/`, `resume.example.json`, and `config.json` have been deleted from this branch. `src/` (TypeScript) is the only pipeline, full stop — there is no "two trees" situation to reason about anymore. v0 is preserved for history on the `main` branch only; never reference `scripts/` as a live path. Decision log for every v2 architecture choice: `main-v2.md` (read before any v2 work). Full spec: `docs/superpowers/specs/2026-07-21-main-v2-architecture-design.md`. A one-off migrator for profiles still shaped like v0, `scripts-v2-migrate/migrate.ts --profile <name> [--write]` (dry-run by default), reads a profile's legacy `resume_meta.json`/`filter_config.json` once to produce v2's `filter.json`.

## Mandatory: Node 24

The pipeline requires **Node ≥ 24** (native TypeScript type-stripping — there is no build step; `.ts` files run directly, per `engines.node` in `package.json`). The machine default is older, which fails immediately on any command. Every command must run under Node 24:

```bash
source ~/.nvm/nvm.sh && nvm use 24 && <command>
```

## Commands

```bash
npm run check                                     # THE gate: typecheck + lint + boundaries + tests
npm run typecheck                                 # tsc --noEmit
npm run lint                                       # biome check src
npm run boundaries                                # depcruise src (dependency-direction rules)
npm test                                           # node --test src/**/*.test.ts + scripts-v2-migrate/**/*.test.ts + test/**/*.test.ts
node --test src/core/filter/engine.test.ts        # single test file
node src/cli/main.ts run --profile <name> [--resume] [--headless] [--dry-run] [--run-cap-ms <ms>]
node src/cli/main.ts doctor --profile <name>
node src/cli/main.ts stage <stage-name> --profile <name>
node src/cli/main.ts routine <routine-name> --profile <name>
```

`jobbunny` (`package.json` `bin`) is `src/cli/main.ts` — same commands without the `node` prefix once installed/linked. Full usage: `src/cli/main.ts`'s `USAGE` string. `npm run release` runs `jobbunny release <X.Y.Z> [--dry-run] [--no-merge] [--yes]`. There is no separate lint/build step beyond what `npm run check` runs; CI's `test` check is exactly `npm run check`.

**Runtime verification:** use the committed fixture profile `profiles/rajni/` (synthetic data, no Notion IDs) — see the `/verify` skill. Never run test/experimental stages against `profiles/harish/`; it holds real user data.

## Profile resolution

`--profile <name>` is required on every `jobbunny` command except `schedule install` (cross-profile by design). `src/cli/wire.ts` is the single place that turns a profile name + config into a running pipeline: it reads `profiles/<name>/profile.json` (`PipelineConfigSchema` — lanes, connector, notifiers, routines, schedule) and `profiles/<name>/filter.json` (`FilterConfigSchema`), validates both with zod, and maps the enabled names onto real adapter constructors — nothing else instantiates an adapter. A missing/invalid `profile.json` throws loudly at wire time (`ops/doctor/aggregate.ts`'s `profileParsesCheck` reports the same failure without throwing, for `/doctor`-style diagnosis).

Per profile (`profiles/<name>/`): `profile.json` (lanes, connector, notifiers, routines, schedule), `filter.json` (the sole geo/skills/rank authority — `resume_meta.json` is dead in v2 runtime code), `resume.json` (hand-maintained), `search_urls.md` (drives `lane add-url`/`/page-analyse`). `avoid.md` is still scaffolded by `setup`/`profile build` but read by zero v2 code — vestigial, kept only so `migrate.ts` can still import a v0 avoid-list; edit `filter.json`'s `title`/`companies` blocks instead. There are no more hand-maintained ATS board watchlist files — Greenhouse/Keka company state is auto-managed in `data/registry/companies.json`. Per-run intermediates live in `profiles/<name>/data/` and are **gitignored** (`.gitignore:59`, `profiles/*/data/*`) except the two tracked rajni fixture files (`data/jobs_raw.json`, `data/cache.json`).

Secrets: `NOTION_TOKEN` and `TELEGRAM_BOT_TOKEN` live in `.env` (gitignored, loaded once at `src/cli/main.ts` via `dotenv/config` — the one bin entry point, so this must not be duplicated elsewhere); Notion DB/page IDs live in `profile.json`, never in `.env`.

## Pipeline architecture

One `jobbunny` CLI drives a frozen 10-stage in-process pipeline (`src/cli/wire.ts`), each stage a typed function; the runner (`src/pipeline/runner/`) checkpoints after every stage:

```
reconcile → farm → source → compress → structure → assemble → filter → dedup → rank → sync
```

| Stage | Module | Role |
|---|---|---|
| reconcile | `pipeline/stages/reconcile.ts` | rebuilds the dedup cache from the live Notion DB (read-only) |
| farm | `pipeline/stages/farm.ts` | runs each `FarmingLane` (currently LinkedIn, browser-driven; auto-launches/kills debug Chrome unless `JOBBUNNY_KEEP_BROWSER=1`); writes `registry/companies_seen.json` |
| source | `pipeline/stages/source.ts` | drives every `ApiLane` (Greenhouse, Keka) against `data/registry/companies.json` (auto-managed; `curated: true` entries are never re-probed/expired); probes/fetches, `maxNewPerLane` capped |
| compress | `pipeline/stages/compress.ts` | truncates raw JD text (2500 chars), emits the LLM's markdown input |
| **structure** | `pipeline/stages/structure.ts` | LLM stage via `ports/llm.ts` (`ClaudeCliProvider` wraps `claude -p`); 25-row batches, per-batch checkpoint |
| assemble | `pipeline/stages/assemble.ts` | zod-parses structured output into `StructuredJD`; unparseable rows → `DroppedRecord` |
| filter | `pipeline/stages/filter.ts` | `core/filter` engine: title/company/location/timezone/skills rules, hard/soft verdicts |
| dedup | `pipeline/stages/dedup.ts` | drops reposts/intra-run dupes against the reconciled cache |
| rank | `pipeline/stages/rank.ts` | 100-pt scale, 5 axes, excitement banding |
| sync | `pipeline/stages/sync.ts` | pushes to Notion via `adapters/db/notion`, automated fields only |

Architecture: hexagonal-lite — `core/` (pure, zod schemas + engines, no I/O) + `ports/` (TS interfaces) + `adapters/` (implementations: `db/notion`, `lanes/{linkedin,greenhouse,keka}`, `llm/claude-cli`, `notify/telegram`, `browser/cdp-chrome`, `scheduler/launchd`) + `pipeline/` (stages + runner) + `routines/` (e.g. `cleanup`) + `ops/` (doctor, observability) + `cli/`. `dependency-cruiser` (`.dependency-cruiser.cjs`, run via `npm run boundaries`) mechanically enforces the direction:

| Rule | Forbids |
|---|---|
| `core-is-pure` | `core/` importing `ports`, `adapters`, `pipeline`, `routines`, `ops`, or `cli` |
| `ports-only-core` | `ports/` importing anything but `core` |
| `adapters-no-cross-family` | one adapter family importing another (e.g. LinkedIn importing Notion) |
| `adapters-only-ports-core` | `adapters/` importing `pipeline`, `routines`, `ops`, or `cli` |
| `only-wire-imports-adapters` | anything except `cli/wire.ts` importing `src/adapters/**` |
| `nothing-imports-cli` | `core`/`ports`/`adapters`/`pipeline`/`routines`/`ops` importing `cli` |

Note: `boundaries` parses via `@swc/core` with `tsConfig` omitted (dependency-cruiser 18.x's typescript resolver caps below TS7; setting `tsConfig` silently cruises 0 modules).

Key invariants:

- **Notion is the source of truth.** `reconcile` rebuilds the cache from the live DB every run (read-only). `sync` writes only automated fields, never user-edited ones.
- **Fail-soft where breadth matters, fail-loud on total outage.** A single broken URL, card, company probe, or board fetch is a `SoftError` — recorded, run continues. But a stage that attempted work and captured **nothing** must be loud: the LinkedIn lane throws if every attempted URL yields zero JDs (shaped like an expired login) — a partial lane failure stays fail-soft, a total one is fail-loud. `core/errors`' `SoftError` type makes this a compile-time distinction, not a convention.
- **Lanes are config-driven, not code-driven.** Selectors and page behavior come from `page_inventory/<page>.md` at runtime. DOM drift is fixed by regenerating the inventory (`/page-analyse`), never by editing lane code.
- **Farm writes what source reads.** `farm` (browser lanes) must run before `source` (API lanes) in the same invocation: it side-writes `registry/companies_seen.json`, which `source` folds into the company registry (`core/company`) via `upsertSeen`.
- **The runner is the single notifier.** Success and failure digests are both built from `result.json` at run end — no double-notify, no headless guard.
- **Uniform checkpoints.** After every stage the runner writes `profiles/<name>/data/runs/<date>/NN-<stage>.json`; a crashed run resumes from the last one (`--resume`).

## Slash commands

Only four survive as slash commands, everything else is a plain `jobbunny` subcommand:

- `/setup <profile>` — onboarding wizard; the interactive parts (Notion adopt-or-create via MCP, secrets prompt, resume parse) that `jobbunny setup` deliberately can't do non-interactively.
- `/page-analyse <page-slug>` — browser-driven DOM analysis; writes/refreshes `page_inventory/<page>.json`.
- `/structure` — the LLM stage itself; there is no `structure.ts` script, Claude produces the markdown table inline.
- `/wrap` — session close-out (design doc/log/roadmap), calls `jobbunny release` for the ship path.

Plus the `verify` skill (`.claude/skills/verify/SKILL.md`) for exercising stages against `profiles/rajni/`. There is no `/notify-setup` — Telegram wiring is a manual procedure now (README).

## Before any PR

`main` is protected — work branches per the task's convention, lands via a PR with the `test` check (`npm run check`) green. Gate for code changes: `npm run check`. Doc-only changes need only a passing `npm run check` (docs don't affect it, but confirm nothing broke).

## Hard rules

- **Notion select option strings are byte-exact** (`adapters/db/notion/schema.ts`, pinned in `schema.test.ts` against a frozen snapshot of v0's option strings) — changing one without first updating the live Notion DB's options makes sync throw. Inserts and anchored updates only; never whole-page overwrite or hard delete — `routine cleanup` archives (Notion's own recoverable `archived: true`, 30-day undo) using `profile.json`'s `settings.cleanup.{passedOlderThanDays:7, untouchedOlderThanDays:30}` and is gated dry-run by `settings.notion.dryRun` (default `true`, edited directly in `profile.json`).
- **`filter.json`'s `locations[]` is the only geo authority** — resume location is dead in v2. Consumed by `core/filter`'s `location` rule.
- **Token efficiency is a design constraint on the `/structure` path.** `compress` truncates raw JD text to 2500 chars and emits a markdown table; the structure stage's output stays a markdown table, not JSON. Preserve this shape.
- **No PDF parsing in the daily path** — `resume.json` is hand-maintained; PDF→JSON is a one-time `/setup` seed only.
- **Seeding never clobbers.** `jobbunny profile build` derives `filter.json` skills/rank weights from `resume.json`; it fills gaps in user-tuned config, never overwrites them — reruns propose a diff.
- **`profile remove` is dry-run by default and refuses `rajni`** (the only hardcoded protected name — it's the committed fixture); pass `--force` to actually delete `profiles/<name>/`. It never touches Notion — archive stale jobs first via `routine cleanup` (with `settings.notion.dryRun: false`) if that's wanted.
- **`AbortSignal` is the deadline mechanism everywhere.** Every CDP/network/LLM call is bound by `ctx.signal`; no unbounded await in an adapter.
- **Markdown is code here.** `.claude/commands/*.md`, `page_inventory/*.md`, `main-v2.md`, and this file are LLM instructions loaded into context — state each rule once; prefer tightening an existing line over adding a new one.

## Conventions

- ESM throughout, Node ≥ 24, TypeScript 7 (native, `--noEmit` typecheck, strict, erasable-syntax-only — no enums/namespaces), zod for schemas, Biome for lint/format. Runtime deps kept to three: `@notionhq/client`, `playwright`, `zod` (Telegram via `fetch`, `.env` via `dotenv/config`, CLI via `node:util` `parseArgs`, tests via `node:test`).
- **Two-pair rule:** every module is a folder with an `index.ts` public surface; internals aren't imported across module boundaries. When a folder exceeds two implementation files (main + test pairs, `index.ts` excluded), split it into subfolders before adding a third.
- Colocated tests (`foo.ts` + `foo.test.ts`), `node:test` runner.
- Pipeline code never names a concrete adapter ("Notion", "LinkedIn") — it only sees port types (`Connector`, `FarmingLane[]`, `ApiLane[]`). `cli/wire.ts` is the only file allowed to instantiate one.
- `main-v2.md` and per-module contracts are architecture docs as code — update them in the same change that alters behavior.

## Known limitations (as of the 2026-07-25 live verification)

- **LinkedIn's `#job-details` selector times out on direct-nav `/jobs/view/` pages** — the committed inventory's `jdRoot` was only ever verified against the `/jobs/search/` split-pane view. JD text recovery currently relies entirely on the anchor-text fallback in `src/adapters/lanes/linkedin/jd_open.ts` (scans for the shortest element starting with "About the job" and ≥ 200 chars). This mirrors long-standing v0 behavior — not a regression — but the inventory should be regenerated (`/page-analyse`) against a live `/jobs/view/` page.
- **`farm`'s funnel reports `jobsIn: 0`** — the shared funnel helper (`ops/observability/result.ts`) measures `payload.jobs.length` before/after a stage, and `farm` is additive (a source stage, like `source`), not a filter. Cosmetic only; `dropsByRule` still reconciles correctly.
- **`profiles/harish/` still carries legacy files** (`filter_config.json`, `resume_meta.json`, `greenhouse_boards.md`, `keka_boards.md`) alongside `filter.json` — run `scripts-v2-migrate/migrate.ts --profile harish` (dry-run first) to confirm it's fully on the v2 config shape before treating it as migrated. Never read or run the pipeline against it — real user data.
