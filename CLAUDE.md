# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Job Bunny is a personal job-search pipeline: it scrapes LinkedIn job searches with Playwright over Chrome CDP, pulls postings from keyless ATS APIs (Greenhouse, Keka), structures/filters/ranks them against a resume profile, and stores the results in a per-profile local SQLite DB browsed via a local job-board UI (`jobbunny board`), with opt-in one-way Notion mirroring and optional Telegram digests. Cross-platform (macOS, Windows, Linux): scheduling is an in-process daemon (`jobbunny serve start|stop|status`; darwin-only autostart via `jobbunny autostart enable|disable`), not launchd, and Chrome discovery resolves per-OS candidate paths rather than one hardcoded macOS path. Architecture rationale lives in the explainer agent's KB (`.claude/agents/explainer.md`) — consult it before any architecture work.

## Stability principle

Pipeline stability is paramount. A feature or fix that destabilizes the
pipeline is reworked or rejected before it merges — no exception for how
valuable the feature is. Any change touching the core pipeline (`pipeline/`,
`runner/`, `adapters/`, `ports/`) is designed deliberately, not elaborately:
reviewed for blast radius and failure modes, never shipped on unit tests
alone.

## Mandatory: Node 24

Node ≥ 24 required (native type-stripping, no build step); the repo pins it via `.nvmrc`, so plain `node`/`npm` commands just work; if `node -v` ever shows < 24, run `source ~/.nvm/nvm.sh && nvm use 24`.

## Commands

```bash
npm run check                                     # THE gate: typecheck + lint + boundaries + tests; CI runs it as a 3-OS `check` matrix (macos/ubuntu/windows) plus a ubuntu-only `ui` job (`ui:check` + `ui:build` + Playwright e2e via `ui:e2e`), behind a `needs`-wrapper job named `test`, which keeps the branch-protection check name
node --test src/core/filter/engine.test.ts        # single test file
node src/cli/main.ts run --profile <name> [--resume] [--headless] [--dry-run] [--run-cap-ms <ms>]
node src/cli/main.ts doctor --profile <name>
node src/cli/main.ts stage <stage-name> --profile <name>
node src/cli/main.ts routine <routine-name> --profile <name>
node src/cli/main.ts migrate --profile <name> [--apply]  # Notion → local sqlite import; dry-run by default
node src/cli/main.ts board [--port <n>]           # job-board UI + API, all profiles, 127.0.0.1 only (default port 1994)
node src/cli/main.ts runs --profile <name> [show <id>]   # run history from the DB
npm run ui:build                                  # build the board SPA into ui/dist (its gate: npm run ui:check; e2e smoke: npm run ui:e2e)
node src/cli/main.ts serve start|stop|status
node src/cli/main.ts autostart enable|disable     # darwin only
```

`jobbunny` (`package.json` `bin`) is `src/cli/main.ts` — full usage in its `USAGE` string. Releases: `npm run release -- <X.Y.Z> [--dry-run] [--no-merge] [--yes]` — the `--` separator is mandatory (without it npm eats the flags; the CLI detects that and refuses).

**Runtime verification:** use the committed fixture profile `profiles/rajni/` (synthetic data) — see the `verify` skill. Never run test/experimental stages against `profiles/harish/`; it holds real user data.

## Profiles

`--profile <name>` is required on every command except `serve` (all three sub-actions), `autostart` (darwin only), and `release` — all cross-profile by design. `src/cli/wire/compose.ts` is the only adapter-instantiation point (the module's public surface is `src/cli/wire/index.ts`): it validates `profile.json` and `filter.json` and wires the enabled names to constructors; a missing/invalid `profile.json` throws at wire time (`doctor` reports the same failure without throwing).

Per profile (rows in the per-profile DB's `config_docs`, edited via `jobbunny config get|set` or the board Settings page; legacy files are one-time lift sources, never written back): `profile.json`, `filter.json` (the sole geo/skills/rank authority), `resume.json` (human-maintained), `search_urls.md` (drives `lane add-url`/`/page-analyse`). `avoid.md` is no longer seeded and read by no runtime code — use `filter.json`'s `title`/`companies` blocks instead. Greenhouse/Keka company state is auto-managed in the per-profile DB (`state_docs` key `registry/companies.json`); there are no hand-maintained board watchlists. Per-run intermediates in `profiles/<name>/data/` are gitignored except the two tracked rajni fixture files.

Secrets: `NOTION_TOKEN` and `TELEGRAM_BOT_TOKEN` live in `.env`, loaded once at `src/cli/main.ts` via `dotenv/config` (the one bin entry point — don't duplicate the load). Notion DB/page IDs live in `profile.json`, never in `.env`. `NOTION_TOKEN` is required only for `connector: "notion"` profiles or sqlite profiles with the mirror enabled — `jobbunny setup` reports it `skipped` otherwise. New profiles scaffold local-first (`connector: "sqlite"`).

## Pipeline architecture

One CLI drives a frozen 10-stage in-process pipeline (`src/cli/wire/compose.ts`); the runner (`src/pipeline/runner/`) checkpoints after every stage:

```
reconcile → farm → source → compress → structure → assemble → filter → dedup → rank → sync
```

Per-stage roles, timeouts, and failure semantics live in the explainer KB (§2.1).

Layers: `core/` (pure, no I/O) + `ports/` (interfaces) + `adapters/` + `pipeline/` + `routines/` + `ops/` + `app/` + `cli/`. `npm run boundaries` (dependency-cruiser) mechanically enforces:

| Rule | Forbids |
|---|---|
| `core-is-pure` | `core/` importing anything outward |
| `ports-only-core` | `ports/` importing anything but `core` |
| `adapters-no-cross-family` | one adapter family importing another |
| `adapters-only-ports-core` | `adapters/` importing `pipeline`, `routines`, `ops`, or `cli` |
| `app-only-ports-core` | `app/` importing anything but `ports`/`core` (or its own `shared/`) |
| `only-cli-imports-app` | anything except `cli` importing `src/app/**` |
| `only-wire-imports-adapters` | anything except `cli/wire/compose.ts` (plus `builders.ts`, `board.ts`, and `registry.ts`'s type-only exception) importing `src/adapters/**` |
| `nothing-imports-cli` | anything importing `cli` |

Note: `boundaries` parses via `@swc/core` with `tsConfig` omitted — setting `tsConfig` silently cruises 0 modules (dependency-cruiser's typescript resolver caps below TS7).

Key invariants:

- **Notion is the source of truth.** `reconcile` reads the live DB every run; `sync` writes only automated fields, never user-edited ones.
- **Fail-soft where breadth matters, fail-loud on total outage.** One broken URL/card/probe/fetch is a `SoftError` — recorded, run continues. A stage that attempted work and captured **nothing** throws loud (e.g. the LinkedIn lane when every attempted URL yields zero JDs — shaped like an expired login).
- **Lanes are config-driven.** Selectors and page behavior come from `src/adapters/lanes/linkedin/page_inventory/<page>.json` at runtime; DOM drift is fixed by regenerating the inventory (`/page-analyse`), never by editing lane code.
- **Farm writes what source reads.** `farm` must run before `source`: it side-writes `registry/companies_seen.json`, which `source` folds into the company registry.
- **The runner is the single notifier.** Success and failure digests are both built from the run's `RunResult` at run end; run observability (history, funnels, log events) is recorded in the per-profile sqlite DB (`runs`/`run_events` via `ports/run_store.ts`), not in files.
- **Uniform checkpoints.** Each invocation owns its own checkpoint group (`run_date` + local `HH-MM` time-dir) in the per-profile sqlite DB (`checkpoints` table via `ports/checkpoint_store.ts`); the runner writes a checkpoint row after every stage. `--resume` seeds from the latest checkpoint in the latest earlier same-day group; `stage <name>` continues in today's latest existing group, so a chain of single-stage runs shares checkpoints. Checkpoint writes are fail-loud — losing one fails the run.
- **Local sqlite is the source of truth when `connector: "sqlite"`.** The opt-in Notion mirror (`settings.notion.mirror: true`) is a one-way, budgeted, best-effort push — mirror failures or slowness never fail, stall, or red a run or doctor. Every profile has `profiles/<name>/data/jobbunny.db` regardless of connector — runs observability always lives there; a DB failure on a notion-connector profile degrades to a no-op run store, never a failed run.

## Slash commands

Only four exist; everything else is a plain `jobbunny` subcommand:

- `/setup <profile>` — onboarding wizard (the interactive parts `jobbunny setup` can't do: Notion adopt-or-create via MCP, secrets prompt, resume parse).
- `/page-analyse <page-slug>` — browser-driven DOM analysis; writes/refreshes `src/adapters/lanes/linkedin/page_inventory/<page>.json`.
- `/structure` — the LLM stage run inline by Claude (no API key).
- `/wrap` — session close-out; calls `jobbunny release` for the ship path.

Plus the `verify` skill for exercising stages against `profiles/rajni/`. Telegram wiring is a manual procedure (README).

## Before any PR

`main` is protected — land via a PR with the `test` check (`npm run check`) green.

## Hard rules

- **Notion select option strings are byte-exact** (`adapters/db/notion/schema.ts`, pinned by `schema.test.ts` against a frozen snapshot) — changing one without first updating the live Notion DB's options makes sync throw. Inserts and anchored updates only; never whole-page overwrite or hard delete — `routine cleanup` archives (recoverable, 30-day undo) per `settings.cleanup`, gated by `settings.notion.dryRun` (default `true`); it also prunes local `profiles/<name>/data/runs/<date>/` folders strictly older than `settings.cleanup.runsOlderThanDays` (default 30, per-profile).
- **`filter.json`'s `locations[]` is the only geo authority** — resume location is never read.
- **Token efficiency on the structure path.** JD text capped at 2500 chars; the structure stage's input and output stay markdown tables, not JSON. Preserve this shape.
- **No PDF parsing in the daily path** — `resume.json` is hand-maintained; PDF→JSON is a one-time `/setup` seed only.
- **Seeding never clobbers.** `jobbunny profile build` fills gaps in user-tuned `filter.json`, never overwrites — reruns propose a diff.
- **`profile remove` is dry-run by default and refuses `rajni`** (the committed fixture); `--force` actually deletes `profiles/<name>/`. It never touches Notion.
- **`AbortSignal` is the deadline mechanism everywhere.** Every CDP/network/LLM call is bound by `ctx.signal`; no unbounded await in an adapter.
- **The LinkedIn lane paces itself and trips a throttle breaker.** 5–12s jitter per navigation plus a 20–45s pause between saved-search URLs (`settings.linkedin.jitterMinMs/jitterMaxMs/interUrlDelayMinMs/interUrlDelayMaxMs`, defaults in `cli/wire/settings.ts`). Consecutive server-withheld JD shells (`jdRoot` present, text empty — a soft-block, never selector drift) open a time-boxed, session-scoped circuit breaker shared by every profile; thresholds, duration, and state location are lane constants — see `src/adapters/lanes/linkedin/`. An open breaker makes the lane return a **skipped** result without launching Chrome; `farm` excludes skipped lanes from its total-outage denominator, so the rest of the pipeline still runs.
- **The board server binds `127.0.0.1` and writes only the `tracking` and config tables.** `jobs` and the runs tables stay pipeline/runner-only — the split is structural (`ports/board.ts`). The `ui/` workspace stays outside the root gate; `biome`/`depcruise`/file-size caps scope to `src/**` only.

## Conventions

- ESM, TypeScript 7 (strict, erasable-syntax-only — no enums/namespaces), zod for schemas, Biome for lint/format. Runtime deps stay at three: `@notionhq/client`, `playwright`, `zod` (Telegram via `fetch`, CLI via `node:util` `parseArgs`, tests via `node:test`).
- **Two-pair rule:** every module is a folder with an `index.ts` public surface; internals aren't imported across module boundaries. A folder exceeding two implementation files (test pairs and `index.ts` excluded) gets split into subfolders first.
- Colocated tests (`foo.ts` + `foo.test.ts`).
- Pipeline code never names a concrete adapter — it sees only port types; `cli/wire/compose.ts` is the one file allowed to instantiate one.
- Per-module contracts, the baked-in KB in `.claude/agents/explainer.md`, and the rules in `.claude/agents/executor.md` are architecture docs as code — update them in the same change that alters behavior.

## Known limitations

- **`farm`'s funnel reports `jobsIn: 0`** — the funnel helper measures jobs before/after a stage and `farm` is additive. Cosmetic; `dropsByRule` reconciles correctly.
