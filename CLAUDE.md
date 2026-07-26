# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Job Bunny is a personal job-search pipeline: it scrapes LinkedIn job searches with Playwright over Chrome CDP, pulls postings from keyless ATS APIs (Greenhouse, Keka), structures/filters/ranks them against a resume profile, and syncs the results to a per-profile Notion database, with optional Telegram digests. macOS only (launchd scheduling, hardcoded Chrome path). `src/` (TypeScript) is the only pipeline; v0 lives on the `main` branch for history — never reference `scripts/` as a live path. Architecture decision log: `main-v2.md` (read before any architecture work).

## Mandatory: Node 24

Node ≥ 24 (native TypeScript type-stripping, no build step). The machine default is older and fails immediately, so prefix every command:

```bash
source ~/.nvm/nvm.sh && nvm use 24 && <command>
```

## Commands

```bash
npm run check                                     # THE gate: typecheck + lint + boundaries + tests; CI's `test` check is exactly this
node --test src/core/filter/engine.test.ts        # single test file
node src/cli/main.ts run --profile <name> [--resume] [--headless] [--dry-run] [--run-cap-ms <ms>]
node src/cli/main.ts doctor --profile <name>
node src/cli/main.ts stage <stage-name> --profile <name>
node src/cli/main.ts routine <routine-name> --profile <name>
```

`jobbunny` (`package.json` `bin`) is `src/cli/main.ts` — full usage in its `USAGE` string. Releases: `npm run release -- <X.Y.Z> [--dry-run] [--no-merge] [--yes]` — the `--` separator is mandatory (without it npm eats the flags; the CLI detects that and refuses).

**Runtime verification:** use the committed fixture profile `profiles/rajni/` (synthetic data, no Notion IDs) — see the `verify` skill. Never run test/experimental stages against `profiles/harish/`; it holds real user data.

## Profiles

`--profile <name>` is required on every command except `schedule install` (cross-profile by design). `src/cli/wire.ts` is the only place that instantiates adapters: it zod-validates `profiles/<name>/profile.json` (`PipelineConfigSchema` — lanes, connector, notifiers, routines, schedule) and `filter.json` (`FilterConfigSchema`) and wires the enabled names to constructors; a missing/invalid `profile.json` throws at wire time (`doctor` reports the same failure without throwing).

Per profile: `profile.json`, `filter.json` (the sole geo/skills/rank authority), `resume.json` (hand-maintained), `search_urls.md` (drives `lane add-url`/`/page-analyse`). `avoid.md` is scaffolded but read by no runtime code — edit `filter.json`'s `title`/`companies` blocks instead. Greenhouse/Keka company state is auto-managed in `data/registry/companies.json`; there are no hand-maintained board watchlists. Per-run intermediates in `profiles/<name>/data/` are gitignored except the two tracked rajni fixture files.

Secrets: `NOTION_TOKEN` and `TELEGRAM_BOT_TOKEN` live in `.env`, loaded once at `src/cli/main.ts` via `dotenv/config` (the one bin entry point — don't duplicate the load). Notion DB/page IDs live in `profile.json`, never in `.env`.

## Pipeline architecture

One CLI drives a frozen 10-stage in-process pipeline (`src/cli/wire.ts`); the runner (`src/pipeline/runner/`) checkpoints after every stage:

```
reconcile → farm → source → compress → structure → assemble → filter → dedup → rank → sync
```

| Stage | Role |
|---|---|
| reconcile | rebuilds the dedup cache from the live Notion DB (read-only) |
| farm | runs each `FarmingLane` (currently LinkedIn; auto-launches/kills debug Chrome unless `JOBBUNNY_KEEP_BROWSER=1`); writes `registry/companies_seen.json` |
| source | drives every `ApiLane` (Greenhouse, Keka) against the company registry; `curated: true` entries are never re-probed/expired; `maxNewPerLane` capped |
| compress | truncates raw JD text (2500 chars), emits the LLM's markdown input table |
| structure | LLM stage via `ports/llm.ts` (`ClaudeCliProvider` wraps `claude -p`); 25-row batches, per-batch checkpoint |
| assemble | zod-parses structured output into `StructuredJD`; unparseable rows → `DroppedRecord` |
| filter | `core/filter` engine: title/company/location/timezone/skills rules, hard/soft verdicts |
| dedup | drops reposts/intra-run dupes against the reconciled cache |
| rank | 100-pt scale, 5 axes, excitement banding |
| sync | pushes to Notion, automated fields only |

Layers: `core/` (pure, no I/O) + `ports/` (interfaces) + `adapters/` + `pipeline/` + `routines/` + `ops/` + `cli/`. `npm run boundaries` (dependency-cruiser) mechanically enforces:

| Rule | Forbids |
|---|---|
| `core-is-pure` | `core/` importing anything outward |
| `ports-only-core` | `ports/` importing anything but `core` |
| `adapters-no-cross-family` | one adapter family importing another |
| `adapters-only-ports-core` | `adapters/` importing `pipeline`, `routines`, `ops`, or `cli` |
| `only-wire-imports-adapters` | anything except `cli/wire.ts` importing `src/adapters/**` |
| `nothing-imports-cli` | anything importing `cli` |

Note: `boundaries` parses via `@swc/core` with `tsConfig` omitted — setting `tsConfig` silently cruises 0 modules (dependency-cruiser's typescript resolver caps below TS7).

Key invariants:

- **Notion is the source of truth.** `reconcile` reads the live DB every run; `sync` writes only automated fields, never user-edited ones.
- **Fail-soft where breadth matters, fail-loud on total outage.** One broken URL/card/probe/fetch is a `SoftError` — recorded, run continues. A stage that attempted work and captured **nothing** throws loud (e.g. the LinkedIn lane when every attempted URL yields zero JDs — shaped like an expired login).
- **Lanes are config-driven.** Selectors and page behavior come from `page_inventory/<page>.json` at runtime; DOM drift is fixed by regenerating the inventory (`/page-analyse`), never by editing lane code.
- **Farm writes what source reads.** `farm` must run before `source`: it side-writes `registry/companies_seen.json`, which `source` folds into the company registry.
- **The runner is the single notifier.** Success and failure digests are both built from `result.json` at run end.
- **Uniform checkpoints.** The runner writes `profiles/<name>/data/runs/<date>/NN-<stage>.json` after every stage; `--resume` continues from the last one.

## Slash commands

Only four exist; everything else is a plain `jobbunny` subcommand:

- `/setup <profile>` — onboarding wizard (the interactive parts `jobbunny setup` can't do: Notion adopt-or-create via MCP, secrets prompt, resume parse).
- `/page-analyse <page-slug>` — browser-driven DOM analysis; writes/refreshes `page_inventory/<page>.json`.
- `/structure` — the LLM stage run inline by Claude (no API key).
- `/wrap` — session close-out; calls `jobbunny release` for the ship path.

Plus the `verify` skill for exercising stages against `profiles/rajni/`. Telegram wiring is a manual procedure (README).

## Before any PR

`main` is protected — land via a PR with the `test` check (`npm run check`) green.

## Hard rules

- **Notion select option strings are byte-exact** (`adapters/db/notion/schema.ts`, pinned by `schema.test.ts` against a frozen snapshot) — changing one without first updating the live Notion DB's options makes sync throw. Inserts and anchored updates only; never whole-page overwrite or hard delete — `routine cleanup` archives (recoverable, 30-day undo) per `settings.cleanup`, gated by `settings.notion.dryRun` (default `true`).
- **`filter.json`'s `locations[]` is the only geo authority** — resume location is never read.
- **Token efficiency on the structure path.** JD text capped at 2500 chars; the structure stage's input and output stay markdown tables, not JSON. Preserve this shape.
- **No PDF parsing in the daily path** — `resume.json` is hand-maintained; PDF→JSON is a one-time `/setup` seed only.
- **Seeding never clobbers.** `jobbunny profile build` fills gaps in user-tuned `filter.json`, never overwrites — reruns propose a diff.
- **`profile remove` is dry-run by default and refuses `rajni`** (the committed fixture); `--force` actually deletes `profiles/<name>/`. It never touches Notion.
- **`AbortSignal` is the deadline mechanism everywhere.** Every CDP/network/LLM call is bound by `ctx.signal`; no unbounded await in an adapter.
- **Markdown is code here.** `.claude/commands/*.md`, `page_inventory/*.md`, `main-v2.md`, and this file are LLM instructions loaded into context — state each rule once; tighten an existing line before adding a new one.

## Conventions

- ESM, TypeScript 7 (strict, erasable-syntax-only — no enums/namespaces), zod for schemas, Biome for lint/format. Runtime deps stay at three: `@notionhq/client`, `playwright`, `zod` (Telegram via `fetch`, CLI via `node:util` `parseArgs`, tests via `node:test`).
- **Two-pair rule:** every module is a folder with an `index.ts` public surface; internals aren't imported across module boundaries. A folder exceeding two implementation files (test pairs and `index.ts` excluded) gets split into subfolders first.
- Colocated tests (`foo.ts` + `foo.test.ts`).
- Pipeline code never names a concrete adapter — it sees only port types; `cli/wire.ts` is the one file allowed to instantiate one.
- `main-v2.md` and per-module contracts are architecture docs as code — update them in the same change that alters behavior, along with the baked-in KB in `.claude/agents/explainer.md` and the rules in `.claude/agents/executor.md`.

## Known limitations

- **LinkedIn's `#job-details` (`jdRoot`) selector doesn't match direct-nav `/jobs/view/` pages** — JD text currently comes from the anchor-text fallback (`behaviors.jdAnchorText` in the inventory), and the lane warns every run this happens. Regenerate the inventory (`/page-analyse`) against a live `/jobs/view/` page to fix properly.
- **`farm`'s funnel reports `jobsIn: 0`** — the funnel helper measures jobs before/after a stage and `farm` is additive. Cosmetic; `dropsByRule` reconciles correctly.
- **`profiles/harish/` carries inert legacy v0 config files** (`filter_config.json`, board `.md`s, `resume_meta.json`) alongside the live v2 set — migration confirmed complete 2026-07-26 (`scripts-v2-migrate/migrate.ts --profile harish` dry-run: no missing v2 keys; avoid.md's alias variants folded into `filter.json` `companies.avoid`). Never read or run the pipeline against it — real user data.
