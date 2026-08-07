# Phase 1: Run Observability → DB

**Date:** 2026-08-05
**Status:** Approved (advisor session, 2026-08-05)
**Parent:** `2026-08-05-persist-to-db-umbrella-design.md` (Approach A, Phase 1 of 4)

## Scope

**In:**

- `result.json`, `run.log`, `heartbeat.json`, `failure.json`, and `sync_dryrun.json` stop being written to disk; a `runs` + `run_events` table pair (schema v2) replaces them.
- The DB becomes unconditional for every profile (umbrella D5).
- Board gets a read-only runs API and a minimal Runs page; a small `jobbunny runs` CLI replaces file-poking for triage; cleanup prunes runs rows.

**Out (Phase 2):**

- Checkpoints: `NN-<stage>.json` files and the `runs/<date>/<HH-MM>/` folders keep working exactly as today; `--resume` and `stage`-chaining mechanics untouched. The run folder is still created — it just no longer receives the five observability files.

**No backfill** (umbrella D7): historical `result.json` files are not imported; old folders age out via existing cleanup.

## Schema (migration v2)

```sql
CREATE TABLE runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date      TEXT NOT NULL,   -- local YYYY-MM-DD, matching schedule.times semantics
  time_dir      TEXT,            -- e.g. '14-30' or '14-30-2'; correlates to the checkpoint folder while Phase 2 is pending
  kind          TEXT NOT NULL,   -- 'run' | 'stage' | 'reconcile'
  resumed_from  INTEGER REFERENCES runs(id),
  status        TEXT NOT NULL,   -- 'running' | 'passed' | 'failed' | 'crashed'
  started_at    TEXT NOT NULL,   -- ISO 8601 UTC
  finished_at   TEXT,
  heartbeat_at  TEXT,
  result_json   TEXT,            -- RunResult funnel (replaces result.json)
  failure_json  TEXT,            -- {stage, error, lastCheckpoint} (replaces failure.json)
  sync_dryrun_json TEXT          -- replaces per-date sync_dryrun.json; also fixes its same-day-overwrite bug
);
CREATE INDEX idx_runs_date ON runs(run_date);

CREATE TABLE run_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    INTEGER NOT NULL REFERENCES runs(id),
  ts        TEXT NOT NULL,
  level     TEXT NOT NULL,
  msg       TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX idx_run_events_run ON run_events(run_id);
```

`run_events` is `run.log`'s JSONL shape (`{ts, level, msg, data}`), one row per line.

## Port and wiring

- **New `ports/run_store.ts`** with a write side for the runner — `startRun(meta) → {runId}`, `appendEvents(runId, events[])` (batched), `heartbeat(runId, ts)`, `recordResult(runId, result)`, `recordFailure(runId, failure)`, `recordSyncDryrun(runId, report)`, `finish(runId, status)` — and a read side for board/CLI: `listRuns(query)`, `getRun(id)`, `listEvents(id)`.
- **Adapter** in `adapters/db/sqlite/runs/`, instantiated only in `cli/wire/compose.ts`, injected into the runner alongside `ctx.storage`. No dependency-cruiser rule changes.
- **`RunFolder`** (`ops/observability/run/run_folder.ts`) keeps only checkpoint duties; its heartbeat/failure/result/log-path members are removed. Existing heartbeat call sites redirect to the port at today's cadence (no cadence change in this phase).
- **Logger:** the `Logger` interface is unchanged; `cli/wire` injects a DB-backed sink (buffered, batched) in place of the JSONL file sink.
- **Single-stage drivers** (`stage`, `reconcile` CLI commands) create runs rows too, with `kind` distinguishing them — mirroring how they get run folders today.
- **Board:** additions are read-only; the "board writes only `tracking`" hard rule is untouched until Phase 4.

## Error handling

- **Observability never reds a run.** Event inserts buffer in memory and flush in batched transactions (on interval and at run end); any DB failure is swallowed after one stderr warning. Same contract as today's `JsonlLogger` and the Notion mirror.
- **No-op fallback:** if the DB cannot be opened on a Notion-connector profile, the runner receives a no-op run store, warns once, and the run proceeds. (For sqlite-connector profiles a dead DB already fails the run for pipeline reasons — unchanged.)
- **Crash detection is derived, not reconciled:** a `running` row with stale `heartbeat_at` (threshold: a constant in the adapter, 10 minutes) displays as crashed; `startRun` additionally tidies prior stale `running` rows to `crashed`.

## Consumers

- **Board API:** `GET /api/runs?profile=<p>` (list, newest first), `GET /api/runs/:id` (funnel + failure + dry-run report), `GET /api/runs/:id/events`. UI: minimal Runs page — list plus a detail view; no design system changes.
- **CLI:** `jobbunny runs --profile <p>` (list) and `jobbunny runs show <id> --profile <p>` (funnel, failure, events).
- **Cleanup routine:** additionally deletes `runs` and `run_events` rows with `run_date` strictly older than `settings.cleanup.runsOlderThanDays` (same setting as folder pruning, which stays for checkpoint folders until Phase 2).
- **Doctor:** check extended — DB present or creatable for every profile (now unconditional).

## Testing and rollout

- Colocated unit tests: migration v2 (fresh create + v1→v2 upgrade), run-store CRUD, sink batching and swallow-on-failure, stale-heartbeat derivation, cleanup row pruning.
- Runner tests switch to a fake run store port; existing checkpoint tests unchanged.
- UI: extend the Playwright e2e smoke to load the Runs page.
- **Live verification before merge** (stability principle): a real staged run against `profiles/rajni/` via the verify skill must produce a complete runs row, correct funnel, and events; kill mid-run must leave a row that displays as crashed; the five files must no longer appear in the run folder.

## Documentation sync (same change)

Explainer KB, triager agent (run-artifact locations), verify skill, and CLAUDE.md's "digests are built from `result.json`" invariant — CLAUDE.md edit text shown verbatim for approval before writing, per standing rule.
