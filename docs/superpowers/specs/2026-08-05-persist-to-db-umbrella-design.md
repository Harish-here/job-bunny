# Persist-to-DB: Umbrella Design

**Date:** 2026-08-05
**Status:** Approved (advisor session, 2026-08-05)
**Scope:** Cross-phase architecture and phase boundaries for moving Job Bunny's file-based persistence into the per-profile sqlite DB. Each phase gets its own detailed spec + implementation plan when it starts; this document is the stable contract they build against.

## Motivation

All four, per user:

1. **Observability in the board** — run history, funnels, and logs queryable and visible instead of write-only JSON files (today `result.json`, `run.log`, `heartbeat.json`, `failure.json` have zero readers in `src/`).
2. **One source of truth / tidiness** — a profile's data dir converges toward `jobbunny.db` plus the checkpoint-era leftovers each phase retires.
3. **Config in DB, editable via UI** — `profile.json` / `filter.json` etc. become DB documents edited through the board, with a JSON export/import escape hatch.
4. **Durability / atomicity** — transactional writes over scattered tmp+rename JSON.

## Decisions log

| # | Decision | Rationale |
|---|---|---|
| D1 | **Machine-level state stays on disk**: daemon logs (`~/.jobbunny/logs/`), LinkedIn breaker state, Chrome/daemon pidfiles, run lock, Chrome user-data-dir. | Pidfiles/locks rely on filesystem `wx`-create atomicity for cross-process safety; the breaker is deliberately session-scoped (shared Chrome profile), not per-profile; the DB is per-profile. |
| D2 | **Checkpoints move to DB** (Phase 2), not just observability artifacts. `runs/` folders disappear at the end of Phase 2. | User choice; done as its own carefully-reviewed phase because it rewrites `--resume`/`stage`-chaining mechanics. |
| D3 | **Config UX = board UI + JSON escape hatch**: settings pages in the board for day-to-day edits; `jobbunny config export/import <profile>` for bulk edits, git-trackable fixtures, and disaster recovery. | User choice (recommended option). |
| D4 | **No central/universal profile registry.** The `profiles/<name>/` directory is the registry; a profile exists iff its directory (and DB) exists. UI profile creation is an endpoint that runs the same scaffold path as the CLI. | A registry DB would be a second source of truth that drifts from the filesystem; nothing needs profiles outside `profiles/` (YAGNI); contradicts D1. |
| D5 | **The DB becomes unconditional** for every profile (Phase 1), regardless of connector. Connector choice governs only where `jobs` sync goes (Notion vs local). | Runs, state, and config need a home on every profile, not only `connector: "sqlite"` ones. |
| D6 | **One DB, phased (Approach A)** — extend `jobbunny.db` via the existing forward-only migration chain; no second `state.db`; no big-bang. | One source of truth, one migration chain, one doctor check; WAL + `busy_timeout` already handle board-reads-during-runner-writes; big-bang violates the stability principle. |
| D7 | **No backfill** of historical `runs/` folder artifacts into the DB. | 30-day ephemera with zero readers today; they age out via existing cleanup. |

## Architecture

### One DB, one migration chain

- Schema owned solely by `src/adapters/db/sqlite/store/migrations.ts`, forward-only, keyed on `PRAGMA user_version`. `LATEST_SCHEMA_VERSION` bumps once per phase: v2 runs (Phase 1), v3 checkpoints (Phase 2), v4 pipeline state (Phase 3), v5 config (Phase 4).
- DB path unchanged: `profiles/<name>/data/jobbunny.db` (overridable via `settings.sqlite.path`), WAL mode, gitignored.

### Table groups and write-ownership zones

Extends the existing structural jobs/tracking split (`ports/board.ts`):

| Group | Tables | Sole writer | Readers |
|---|---|---|---|
| Jobs | `jobs` | pipeline | board, pipeline |
| Tracking | `tracking` | board | board |
| Runs (ph. 1–2) | `runs`, `run_events`, `run_stages` | runner | board, `serve status`, `jobbunny runs`, triage |
| Pipeline state (ph. 3) | cache / registry / structure tables | pipeline stages | pipeline, doctor |
| Config (ph. 4) | config document tables | board + CLI import | wire/compose, board |

### Port-per-phase pattern (boundary compliance)

The runner, stages, and ops never import sqlite. Each phase introduces (or extends) a port in `ports/`, implements it in `adapters/db/sqlite/<area>/`, and wires it exclusively in `cli/wire/compose.ts` — the same pattern as `ctx.storage` today. No dependency-cruiser rule changes are anticipated before Phase 4.

### Concurrency posture (unchanged in spirit)

- WAL + `busy_timeout=5000`; repo-wide run lock keeps one runner; board is read-mostly.
- **Observability never reds a run**: log/event writes are buffered, batched, and fail-soft (swallow after one warning) — the same contract as today's `JsonlLogger` and the Notion mirror.

### Fixture and verify path

`profiles/rajni/`'s tracked JSON files remain the git-visible seed; the DB stays gitignored and is (re)built from them. The `verify` skill's flow keeps its shape; from Phase 4 the build step goes through `jobbunny config import`.

## Phases

Each phase is independently shippable, lands as its own PR(s), and gets its own spec + plan informed by the previous phase.

### Phase 1 — Run observability → DB

- `runs` + `run_events` tables (schema v2) replace `result.json`, `run.log`, `heartbeat.json`, `failure.json`, `sync_dryrun.json`.
- New `ports/run_store.ts`; adapter in `adapters/db/sqlite/runs/`; DB unconditional (D5).
- Board read-only runs API + minimal Runs page; `jobbunny runs` CLI; cleanup prunes runs rows.
- Checkpoints and `runs/` folders untouched.
- **Done when:** a real staged run against `rajni` produces a complete runs row, events, and a correct funnel; the five files are no longer written; cleanup prunes rows.
- Detailed spec: `2026-08-05-runs-observability-db-phase1-design.md`.

### Phase 2 — Checkpoints → DB

- `run_stages` rows (stage index, name, payload blob) replace `NN-<stage>.json`; `--resume` and `stage`-chaining rebuilt on runs rows **preserving today's semantics exactly** (same-day only, latest run wins, positional stage index).
- `runs/` folders stop being created; cleanup's folder pruning retires after a deprecation window for old folders.
- Highest-stability-risk phase: designed against Phase 1's real adapter behavior, reviewed for blast radius, live-verified before merge.
- **Done when:** kill-and-resume and single-stage chaining against `rajni` behave byte-identically to the file mechanism, with no `runs/` folder created.

### Phase 3 — Pipeline state → DB

- `cache/entries.json`, `registry/companies.json` + `companies_seen.json` + `api_seen.json`, structure intermediates (`table.json`, `passthrough.json`, `decisions.json`, `decisions.partial.json`), LinkedIn `captures.json` + `extract_resume.json` become tables behind the storage/state ports.
- The `/structure` skill's file hand-off is replaced by CLI read/write helpers (exact shape decided in the phase spec; the markdown-table token-efficiency rule is preserved).
- **Done when:** a full pipeline run reads/writes no per-profile JSON state files.

### Phase 4 — Config → DB + board UI

- `profile.json`, `filter.json`, `resume.json`, `search_urls.md` become validated document rows (zod-validated at the write boundary; `wire/compose.ts` keeps fail-loud semantics on invalid/missing config).
- Board settings pages (create/edit profile per D4); `jobbunny config export/import` (D3); `lane add-url` writes rows.
- Dead surfaces deleted: `avoid.md` seeding, root `config.json`. `resume.json` content moves to a DB document (stays a /setup-time seed; no PDF parsing in the daily path).
- **Hard-rule amendment:** "board writes only `tracking`" becomes "board writes `tracking` and config tables, never `jobs`/runs". This is a CLAUDE.md edit — proposed text shown verbatim for explicit approval at that time, per standing rule.
- **Done when:** a fresh profile can be created, configured, and run without hand-editing any file; `rajni` fixture rebuilds via import.

## Out of scope (all phases)

- Daemon logs, breaker state, pidfiles, run lock, Chrome user-data-dir (D1).
- Page inventories (`src/adapters/lanes/linkedin/page_inventory/`) — repo-tracked, machine-shared code-adjacent assets, not profile data.
- `ui/dist` and other build artifacts; `README.md` version badge; `.env` secrets (stay in `.env`).
- Legacy v0 debris under `profiles/harish/data/` — separate one-off cleanup, not part of this design.

## Documentation sync obligations

Each phase updates, in the same change: the explainer KB (`.claude/agents/explainer.md`), the triager agent (run-artifact locations change in Phases 1–2), the verify skill, and CLAUDE.md where its invariants are affected (e.g. "digests are built from `result.json`" in Phase 1; checkpoint semantics in Phase 2; the hard-rule amendment in Phase 4 — every CLAUDE.md edit shown verbatim for approval first).
