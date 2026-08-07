# Runs Observability → DB (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sdd-task-loop (this repo's blessed executor flow) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five write-only run-artifact files (`result.json`, `run.log`, `heartbeat.json`, `failure.json`, `sync_dryrun.json`) with `runs` + `run_events` tables in the per-profile sqlite DB, readable from the board, a new `jobbunny runs` CLI, and cleanup.

**Architecture:** New `ports/run_store.ts` port; `SqliteRunStore` adapter in `adapters/db/sqlite/runs/` (lazy-open, fail-soft writer); a buffered `RunStoreLogger` sink replaces `JsonlLogger` for runs; drivers (`run`/`stage`/`reconcile`) open/close runs rows; the runner records failure via the store; board + CLI read. Checkpoints and `runs/` folders are UNTOUCHED (Phase 2).

**Tech Stack:** TypeScript 7 strict (erasable-only), `node:sqlite` (`DatabaseSync`, sync API), zod, `node:test`, Biome, dependency-cruiser.

**Spec:** `docs/superpowers/specs/2026-08-05-runs-observability-db-phase1-design.md` (+ umbrella spec and decision ledger, same directory — ledger L11–L13 record plan-time judgment calls).

## Global Constraints

- Node ≥ 24; no new runtime deps (`node:sqlite` is builtin; runtime deps stay `@notionhq/client`, `playwright`, `zod`).
- Boundaries (dependency-cruiser) hold: `ports/` imports only `core/` (⇒ run-store port uses opaque `unknown` for result/failure blobs, ledger L12); only `cli/wire/compose.ts` (+`builders.ts`, `board.ts`) constructs adapters; `ops/` may import `ports/` but never `adapters/`.
- Two-pair rule: every new module folder gets `index.ts`; ≤2 implementation files per folder (tests + index excluded). Colocated `foo.ts`+`foo.test.ts`.
- **Observability never reds a run**: every store write is fail-soft (catch → one stderr warning → continue). Lazy DB open (ledger L13); `wire()` must not create a DB file.
- Checkpoint mechanics byte-identical: `RunFolder` checkpoint methods, `latestTimeDir`, `nextTimeDir`, `--resume`, `stage` chaining unchanged.
- Gate per task: `npm run check` (typecheck+lint+boundaries+tests) before every commit. UI task additionally `npm run ui:check` + `npm run ui:build` + `npm run ui:e2e`.
- Work in a worktree branched from FRESH `origin/main-everything-db` (fetch first); branch `feat/db-runs-observability`; PR back to `main-everything-db`.
- Commit messages: conventional, no co-author trailers.

---

### Task 1: Schema v2 + run-store port

**Files:**
- Modify: `src/adapters/db/sqlite/store/migrations.ts` (append migration, bump version)
- Modify: `src/adapters/db/sqlite/store/migrations.test.ts`
- Create: `src/ports/run_store.ts`
- Modify: `src/ports/index.ts` (add `export * from './run_store.ts';`)

**Interfaces (Produces — every later task consumes these exact names):**

```ts
// src/ports/run_store.ts
/** Run observability store (persist-to-db Phase 1). Writer side: runner +
 * CLI drivers. Reader side: board + `jobbunny runs` CLI + cleanup. Sync by
 * design — node:sqlite is sync (mirrors ports/board.ts). WRITER methods are
 * fail-soft in implementations: a failure warns once on stderr and never
 * throws (observability must never red a run). */
export type RunKind = 'run' | 'stage' | 'reconcile';
export type RunStatus = 'running' | 'passed' | 'failed' | 'crashed';

export interface RunEventRow {
  ts: string;
  level: string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface RunSummary {
  id: number;
  date: string; // local YYYY-MM-DD (schedule.times convention)
  timeDir: string | null; // 'HH-MM' or 'HH-MM-N' — correlates to the checkpoint folder until Phase 2
  kind: RunKind;
  resumedFrom: number | null;
  status: RunStatus; // 'crashed' is DERIVED on read for stale-heartbeat 'running' rows
  startedAt: string; // ISO 8601 UTC
  finishedAt: string | null;
  heartbeatAt: string | null;
}

export interface RunDetail extends RunSummary {
  /** Opaque JSON blobs — shapes owned by their writers (RunResultSchema
   * lives in ops/observability; ports-only-core forbids importing it here). */
  result: unknown;
  failure: unknown;
  syncDryrun: unknown;
}

export interface RunFailure {
  stage: string;
  error: string;
  elapsedMs: number;
  lastCheckpoint?: string;
}

export interface RunStoreWriter {
  /** Inserts a 'running' row and returns its id. Also tidies PRIOR stale
   * 'running' rows (heartbeat older than the staleness threshold) to
   * 'crashed'. Returns -1 when the store is degraded (open failed). */
  startRun(meta: {
    date: string;
    timeDir?: string;
    kind: RunKind;
    resumedFrom?: number;
    startedAt: string;
  }): number;
  /** Batched insert, one transaction. Also bumps heartbeat_at. */
  appendEvents(runId: number, events: RunEventRow[]): void;
  heartbeat(runId: number, at: string): void;
  recordFailure(runId: number, failure: RunFailure): void;
  recordSyncDryrun(runId: number, report: unknown): void;
  finishRun(runId: number, outcome: 'passed' | 'failed', result: unknown, finishedAt: string): void;
}

export interface RunStoreReader {
  listRuns(opts?: { limit?: number; offset?: number }): RunSummary[];
  getRun(id: number): RunDetail | null;
  listEvents(runId: number, opts?: { limit?: number; offset?: number }): RunEventRow[];
  /** id of the run row recorded for runs/<date>/<timeDir>, or null. */
  findRunId(date: string, timeDir: string): number | null;
  /** Deletes runs (+ their events) with date strictly older than
   * today − ttlDays; never today's. Returns the number of runs deleted. */
  pruneRunsOlderThan(today: string, ttlDays: number): number;
}

export interface RunStore extends RunStoreWriter, RunStoreReader {
  close(): void;
}
```

Migration v2 — append as `MIGRATIONS[1]` and set `LATEST_SCHEMA_VERSION = 2`:

```sql
CREATE TABLE runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date      TEXT NOT NULL,
  time_dir      TEXT,
  kind          TEXT NOT NULL,
  resumed_from  INTEGER REFERENCES runs(id),
  status        TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  heartbeat_at  TEXT,
  result_json   TEXT,
  failure_json  TEXT,
  sync_dryrun_json TEXT
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

**Steps:**

- [ ] **Step 1: failing tests** — extend `migrations.test.ts`: (a) fresh `:memory:` open lands at `user_version = 2` with `runs` and `run_events` present (`SELECT name FROM sqlite_master WHERE type='table'`); (b) a db pre-stamped v1 (create with only `MIGRATIONS[0]` applied + `PRAGMA user_version = 1`) upgrades to 2 preserving existing `jobs` rows; (c) a db stamped 3 still throws (existing downgrade test — update its expected version text).
- [ ] **Step 2: run** `node --test src/adapters/db/sqlite/store/migrations.test.ts` — expect FAIL.
- [ ] **Step 3: implement** — append the SQL above to `MIGRATIONS`, bump `LATEST_SCHEMA_VERSION` to 2, create `src/ports/run_store.ts` exactly as specified, export from `src/ports/index.ts`.
- [ ] **Step 4: run** the test again — PASS; then `npm run check`.
- [ ] **Step 5: commit** `feat(db): schema v2 (runs, run_events) + run-store port`

---

### Task 2: SqliteRunStore adapter

**Files:**
- Create: `src/adapters/db/sqlite/runs/store.ts`, `src/adapters/db/sqlite/runs/store.test.ts`, `src/adapters/db/sqlite/runs/index.ts`
- Modify: `src/adapters/db/sqlite/index.ts` (re-export `SqliteRunStore`, `RUN_HEARTBEAT_STALE_MS`)

**Interfaces:**
- Consumes: `openJobsDb` from `../store/index.ts`; `RunStore` + row types from `ports/run_store.ts` (Task 1).
- Produces: `class SqliteRunStore implements RunStore`, constructor `(dbPath: string, deps?: { now?: () => Date; warn?: (msg: string) => void })` (defaults: real clock, `console.error`); `export const RUN_HEARTBEAT_STALE_MS = 10 * 60_000;`

**Behavior contract (each bullet gets a test):**
- **Lazy open (L13):** no file I/O in the constructor. First WRITER call opens via `openJobsDb(dbPath)`. Open failure ⇒ `warn()` once, store becomes a permanent no-op: `startRun` returns -1, other writers return silently, readers return `[]`/`null`/0. A writer called with `runId === -1` is a silent no-op.
- **Fail-soft writers:** every writer method body wrapped in try/catch → `warn()` once per store instance (a `warned` flag), never throws.
- **startRun:** INSERT status 'running'; BEFORE inserting, `UPDATE runs SET status='crashed' WHERE status='running' AND (heartbeat_at IS NULL OR heartbeat_at < <staleCutoff>)` where staleCutoff = now − RUN_HEARTBEAT_STALE_MS as ISO string (lexicographic compare is valid for ISO-8601 UTC).
- **appendEvents:** one `BEGIN`/`COMMIT` transaction of INSERTs; `data` serialized with `JSON.stringify` into `data_json` (NULL when undefined); also `UPDATE runs SET heartbeat_at = <max event ts>`.
- **finishRun:** sets `status` from outcome, `result_json = JSON.stringify(result)`, `finished_at`.
- **recordFailure / recordSyncDryrun:** write the JSON blob columns.
- **listRuns:** newest first (`ORDER BY id DESC`), default limit 50; maps snake_case → the port's camelCase; DERIVES `status: 'crashed'` in the returned summary for 'running' rows whose `heartbeat_at` is null-or-stale vs `deps.now()` (DB row itself untouched).
- **getRun:** blobs `JSON.parse`d back to `unknown` (null column ⇒ `null`).
- **listEvents:** ascending by id, default limit 500, `data_json` parsed.
- **findRunId:** `SELECT id FROM runs WHERE run_date = ? AND time_dir = ? ORDER BY id DESC LIMIT 1`.
- **pruneRunsOlderThan:** compute cutoff exactly like `selectPrunableRunDirs` (`routines/cleanup/cleanup.ts` — UTC midnight of today minus ttlDays; never today even at ttl 0); `DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE run_date < ? AND run_date != ?)` then the runs DELETE; return runs-deleted count.

**Steps:**

- [ ] **Step 1: failing tests** — `store.test.ts` against a temp-dir dbPath (`fs.mkdtempSync`), one test per contract bullet above, plus: full happy path (startRun → appendEvents×2 → recordFailure → finishRun('failed') → listRuns/getRun round-trips every field); stale-tidy (insert running row with old heartbeat via a first store, `startRun` on a second store with fake `now` marks it crashed); degraded mode (dbPath = a path whose PARENT is an existing FILE so mkdir fails ⇒ warn called once, startRun -1, no throw anywhere).
- [ ] **Step 2:** `node --test src/adapters/db/sqlite/runs/store.test.ts` — FAIL.
- [ ] **Step 3: implement** `SqliteRunStore` per contract. Private `open()` memoizes the `DatabaseSync` handle or the failure.
- [ ] **Step 4:** tests PASS; `npm run check`.
- [ ] **Step 5: commit** `feat(db): SqliteRunStore adapter (lazy-open, fail-soft, crash derivation)`

---

### Task 3: RunStoreLogger sink

**Files:**
- Modify: `src/ops/observability/log/loggers.ts` (add class — keeps the folder at two impl files)
- Modify: `src/ops/observability/log/loggers.test.ts`
- Modify: `src/ops/observability/log/factory.ts` + `factory.test.ts`
- Modify: `src/ops/observability/log/index.ts` (exports)

**Interfaces:**
- Consumes: `RunStoreWriter`, `RunEventRow` from `ports` (ops→ports is legal); `LOG_LEVELS`/`shouldLog` already in loggers.ts.
- Produces: `class RunStoreLogger implements Logger` with constructor `(store: RunStoreWriter, runId: number, opts?: JsonlLoggerOptions & { flushMs?: number })` and public sync `flush(): void`. `createRunLogger` signature CHANGES to `createRunLogger(store: RunStoreWriter, runId: number, cfg?: LoggingConfig): RunStoreLogger`.

**Behavior contract:**
- TTY mirror identical to `JsonlLogger` (ttyLevel + `isTTY()` per call, `console.log` of the JSON line).
- `fileLevel`-passing lines are buffered as `RunEventRow`s; a `setTimeout(flushMs ?? 250)` (`.unref()`) coalesces; `level === 'error'` or buffer length ≥ 200 flushes immediately; `flush()` clears the timer and calls `store.appendEvents(runId, batch)` (which is itself fail-soft — no try/catch needed here beyond the store's own).
- `JsonlLogger` class STAYS (daemon/`ConsoleLogger` paths untouched) — only the `createRunLogger` factory switches. Delete nothing else.

**Steps:**

- [ ] **Step 1: failing tests** — fake store capturing `appendEvents` calls: buffering (3 infos → 0 calls before timer, 1 call with 3 events after `flush()`); error-level immediate flush; ttyLevel filtering (reuse the existing JsonlLogger test pattern with injected `isTTY`); factory returns RunStoreLogger honoring `fileLevel: 'warn'` (debug line never buffered).
- [ ] **Step 2:** `node --test src/ops/observability/log/loggers.test.ts src/ops/observability/log/factory.test.ts` — FAIL.
- [ ] **Step 3: implement.** Fix the two `factory.test.ts`/`loggers.test.ts` existing `createRunLogger` expectations. Compile errors in `cli/commands/{run,stage,reconcile}.ts` are EXPECTED here (old signature) — update those three call sites minimally in this task ONLY as far as making them compile is impossible without Tasks 5–7; instead, in THIS task keep a temporary overload NO — do the clean thing: this task also mechanically updates the three call sites to construct the logger from `ctx.runStore` + a placeholder runId of -1 (a no-op sink per Task 2's contract), which Tasks 6–7 then replace with real runIds. `ctx.runStore` does not exist until Task 4 — therefore Task 3 must land AFTER Task 4 in execution order. sdd-task-loop: execute as 1, 2, 4, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14.
- [ ] **Step 4:** PASS; `npm run check`.
- [ ] **Step 5: commit** `feat(obs): RunStoreLogger DB sink replaces JsonlLogger on the run path`

---

### Task 4: Wire the store (compose.ts, PipelineCtx, doctor)

**Files:**
- Modify: `src/pipeline/runner/context.ts` (PipelineCtx: add `runStore: RunStore; runId?: number`)
- Modify: `src/cli/wire/compose.ts`
- Modify: `src/cli/wire/compose.test.ts`

**Interfaces:**
- Consumes: `SqliteRunStore` (Task 2).
- Produces: `ctx.runStore` (a `RunStore`) on every wired profile regardless of connector; `ctx.runId` optional, set by drivers. `WireOverrides.syncDryRunPath` REPLACED by `syncDryRun?: boolean` (Task 6 consumes).

**Steps:**

- [ ] **Step 1: failing test** — compose.test.ts: wiring a notion-connector fixture profile yields `ctx.runStore` instanceof-like duck check (has `startRun`); wiring never creates `jobbunny.db` on disk (assert `!existsSync(sqliteDefaultPath)` after `wire()` — this pins L13).
- [ ] **Step 2:** run compose tests — FAIL.
- [ ] **Step 3: implement** — in `wire()`: resolve `sqlitePath` = (connector === 'sqlite' ? `SqliteConnectorSettingsSchema.parse(config.settings.sqlite ?? {}).path ?? sqliteDefaultPath` : sqliteDefaultPath); `const runStore = new SqliteRunStore(sqlitePath);` add to ctx. Doctor: when `config.connector !== 'sqlite'`, additionally push `sqliteDbCheck({ path: sqlitePath })` (sqlite-connector profiles already get it from the registry — no duplicate). PipelineCtx type extended; fix any test-fixture ctx builders by adding a `SqliteRunStore(':memory:')` or a small inline fake.
- [ ] **Step 4:** PASS; `npm run check`.
- [ ] **Step 5: commit** `feat(wire): ctx.runStore on every profile + unconditional sqlite doctor check`

*(Execute Task 3 here — see its Step 3 note.)*

---

### Task 5: Runner records to the store

**Files:**
- Modify: `src/pipeline/runner/run.ts` + `run.test.ts`

**Interfaces:**
- Consumes: `ctx.runStore`, `ctx.runId` (Task 4), `RunFailure` (Task 1).
- Produces: `runPipeline` — SAME signature — that (a) calls `ctx.runStore.heartbeat(ctx.runId, new Date().toISOString())` at each stage start, (b) on stage failure calls `ctx.runStore.recordFailure(ctx.runId, { stage, error, elapsedMs, lastCheckpoint? })` instead of `folder.writeFailure`, (c) NO LONGER calls `folder.writeResult`/`folder.clearFailure` (the RunResult return value is unchanged — the driver persists it). All store calls guarded by `if (ctx.runId !== undefined)`.

**Steps:**

- [ ] **Step 1: failing tests** — run.test.ts with a recording fake store on ctx: pass path → heartbeat called once per stage, recordFailure never, no result file written (assert fake folder's writeResult NOT called — then delete that expectation once the method is gone in Task 8; for now the fake folder simply won't receive the call); fail path → recordFailure called with the failing stage name and the wrapped `errorText` (existing cause-chain behavior preserved — reuse the existing failure-path test's error fixture).
- [ ] **Step 2:** FAIL. **Step 3: implement.** **Step 4:** PASS + `npm run check`.
- [ ] **Step 5: commit** `feat(runner): heartbeat + failure recording via run store; result files retired from runner`

---

### Task 6: `run` driver opens/closes the run row

**Files:**
- Modify: `src/cli/commands/run.ts` + `run.test.ts`
- Modify: `src/pipeline/stages/sync.ts` + `sync.test.ts` (dry-run write → store)
- Modify: `src/cli/wire/compose.ts` (thread `syncDryRun: boolean` into `makeSyncStage` in place of `dryRunPath`)

**Interfaces:**
- Consumes: everything above.
- Produces: run rows of `kind: 'run'`; `makeSyncStage(connector, opts?: { dryRun?: boolean })` — the sync stage, when `dryRun`, builds the SAME report object it writes today but calls `ctx.runStore.recordSyncDryrun(ctx.runId!, report)` instead of `ctx.storage.writeJson(dryRunPath, report)` (read `sync.ts` first; preserve the report shape byte-for-byte; when `ctx.runId` is undefined — e.g. unit tests — skip the write silently).

**Driver order in `runCommand` (replaces lines ~226–255):** compute `dataDir`, `time` (unchanged) → resume lookup FIRST (unchanged logic; also capture `priorTime`) → `const runId = ctx.runStore.startRun({ date, timeDir: time, kind: 'run', startedAt: now.toISOString(), ...(priorTime ? { resumedFrom: ctx.runStore.findRunId(date, priorTime) ?? undefined } : {}) })` → `ctx.runId = runId` → `ctx.logger = createRunLogger(ctx.runStore, runId, resolveLoggingSettings(...))` (keep a `const runLogger` reference) → routines/pipeline as today → after `runPipeline` returns: `ctx.runStore.finishRun(runId, result.outcome, result, resolved.now().toISOString())` → notify/summary as today → in the existing `finally`, `runLogger.flush()` before lock release. `--dry-run` now wires `{ syncDryRun: true }` instead of `syncDryRunPath` (the per-date-overwrite bug dies here).

**Steps:**

- [ ] **Step 1: failing tests** — run.test.ts (it injects wire/runPipeline fakes): a passed run calls startRun with kind 'run' and finishRun with outcome 'passed' and the RunResult blob; resume path passes `resumedFrom` from `findRunId`; sync.test.ts: dryRun stage run records via a fake ctx.runStore and writes nothing through storage.
- [ ] **Step 2:** FAIL. **Step 3: implement.** **Step 4:** PASS + `npm run check`.
- [ ] **Step 5: commit** `feat(run): runs rows open/close in the driver; sync dry-run report → DB`

---

### Task 7: `stage` + `reconcile` drivers

**Files:**
- Modify: `src/cli/commands/stage.ts` + `stage.test.ts`
- Modify: `src/cli/commands/reconcile.ts` + `reconcile.test.ts`

**Interfaces:** Consumes Task 4/3. Produces rows of `kind: 'stage'` / `'reconcile'`.

**Behavior:** after folder/time resolution (unchanged): startRun({date, timeDir: time, kind, startedAt}) → ctx.runId → store-backed logger. `stage.ts`: wrap the `guardStage` call so success → `finishRun(runId, 'passed', {profile, date, time, outcome: 'passed', stages: [{name, elapsedMs, attempts: 1, ...funnel}]}, ...)` (a well-formed RunResult) and a throw → `recordFailure(runId, {stage: target.name, error: message, elapsedMs})` + `finishRun(runId, 'failed', {...outcome: 'failed', failedStage: target.name, stages: []}, ...)` then RETHROW (main's catch still owns exit 1). `logger.flush()` on both paths (try/finally). Mirror the same pattern in `reconcile.ts` (read it first; same folder/logger scaffold per its lines 90–110).

**Steps:** failing tests (fake store: kind recorded, failure path records + rethrows) → FAIL → implement → PASS + `npm run check` → commit `feat(cli): stage/reconcile drivers record runs rows`.

---

### Task 8: Retire the five file writers (RunFolder slim-down)

**Files:**
- Modify: `src/ops/observability/run/run_folder.ts` + `run_folder.test.ts`
- Modify: `src/ops/observability/run/index.ts` if it re-exports removed names
- Modify: `src/cli/commands/run.ts` (remove now-dead `createRunLogger` file-path import leftovers, if any)

**Behavior:** delete `writeHeartbeat`, `writeFailure`, `clearFailure`, `writeResult`, `logPath` and their tests; keep `checkpointPath`/`writeCheckpoint`/`readLatestCheckpoint`/`latestTimeDir`/`nextTimeDir`/`formatRunTime`/`writeAtomic` EXACTLY as-is. Grep for any remaining caller of the removed methods (there must be none after Tasks 5–7 — if one exists, STOP and report rather than adapt it silently). `RunResult` import in run_folder.ts goes away.

**Steps:** update tests → `npm run check` (typecheck catches stragglers) → commit `refactor(obs): RunFolder is checkpoint-only; five run-artifact files retired`.

---

### Task 9: Cleanup prunes runs rows

**Files:**
- Modify: `src/routines/cleanup/cleanup.ts` + `cleanup.test.ts`

**Behavior:** after the existing folder pruning, `const prunedDbRuns = ctx.runStore.pruneRunsOlderThan(today, settings.runsOlderThanDays);` + `ctx.logger.info('cleanup: pruned run rows', { prunedDbRuns, runsOlderThanDays })`. Same `today` string as the folder path. No new settings key.

**Steps:** failing test (fake ctx.runStore records the call args; existing tests get the fake added) → implement → `npm run check` → commit `feat(cleanup): prune runs/run_events rows with the same TTL as folders`.

---

### Task 10: Board read-only runs API

**Files:**
- Modify: `src/ports/board.ts` (BoardStore gains the three readers)
- Modify: `src/adapters/db/sqlite/board/board.ts` + `board.test.ts`
- Create: `src/app/features/runs/` (`routes.ts`, `routes.test.ts`, `index.ts`) — read `src/app/features/board/` first and mirror its RouteDef/handler/validation pattern exactly
- Modify: `src/app/server/server.ts` (mount `makeRunsRoutes(source)`) + `server.test.ts`

**Interfaces:**
- `BoardStore` additions (types imported from `./run_store.ts` — ports→ports is fine):

```ts
listRuns(query: { limit?: number; offset?: number }): { rows: RunSummary[]; total: number };
getRun(id: number): RunDetail | null;
listRunEvents(id: number, query: { limit?: number; offset?: number }): { rows: RunEventRow[]; total: number };
```

- Routes (mirror the existing profile-scoped job route shapes — check `features/board/routes.ts` for the exact `/api/profiles/:profile/...` pattern and copy it): `GET /api/profiles/:profile/runs` (query limit≤200 default 50, offset), `GET /api/profiles/:profile/runs/:id`, `GET /api/profiles/:profile/runs/:id/events` (limit≤1000 default 500). 404 envelope for unknown profile/run id; non-numeric id → 400 via the existing zod validation pattern.
- Implementation in `board.ts` queries the same tables (share the crash-derivation logic by exporting a helper `deriveStatus(status, heartbeatAt, now)` from `adapters/db/sqlite/runs/index.ts` and using it in both stores). Board WRITES nothing new — the tracking-only hard rule stands.

**Steps:** failing route + store tests (list/detail/events happy path against a temp DB seeded via SqliteRunStore; 404s; validation 400) → FAIL → implement → PASS + `npm run check` → commit `feat(board): read-only runs API (/api/profiles/:profile/runs...)`.

---

### Task 11: Board UI Runs page + e2e smoke

**Files:**
- Create/modify inside `ui/` following its existing structure (read `ui/src` routing/data patterns first; this task is deliberately pattern-following, suited to executor-smart)
- Modify: the Playwright e2e suite (`npm run ui:e2e`) with one smoke: Runs page renders and shows the empty state against a profile with no runs.

**Behavior:** a "Runs" view per profile: list (status chip incl. crashed, date + timeDir, kind, duration from startedAt/finishedAt, failed stage from `failure.stage` when present) + a detail view (funnel table from `result.stages`: name, jobsIn→jobsOut, per-rule drops; events list with level filter). Read-only; no polling beyond manual refresh; reuse the board's existing fetch/error-envelope helpers and design components. Keep it minimal — no charts.

**Steps:** implement → `npm run ui:check` + `npm run ui:build` + `npm run ui:e2e` + `npm run check` → commit `feat(ui): runs history page`.

---

### Task 12: `jobbunny runs` CLI

**Files:**
- Modify: `src/cli/args.ts` (+ its test) — add `runs` command: `runs --profile <p>` and `runs show <id> --profile <p>` (positional sub-action like `serve`/`profile`)
- Create: `src/cli/commands/runs.ts` + `runs.test.ts`
- Modify: `src/cli/main.ts` (registry entry)

**Interfaces:** Consumes the board source (read `src/cli/wire/board.ts` first — it is an allowed adapter-importing wire file; reuse its source/store builder to open the profile's BoardStore, which now has the runs readers from Task 10).

**Behavior:** list → one line per run: `#<id>  <date> <timeDir ?? '-'>  <kind>  <status>  <duration ?? 'running'>  <failedStage ?? ''>`; show → the summary line, then `failure` block if present, then funnel lines (`  <stage>: <jobsIn> -> <jobsOut>` — same format as `funnelSummary` in commands/run.ts), then events (`<ts> <level> <msg>` + compact data JSON). Unknown profile or missing DB → friendly message, exit 1. Update the `USAGE` string in args.ts.

**Steps:** failing args + command tests (injected fake store) → FAIL → implement → PASS + `npm run check` → commit `feat(cli): jobbunny runs — run history from the DB`.

---

### Task 13: Doc-sync (pre-approved)

**Files:**
- Modify: `CLAUDE.md` — the THREE user-approved edits, verbatim from ledger context: (1) replace the sentence `**The runner is the single notifier.** Success and failure digests are both built from \`result.json\` at run end.` with `**The runner is the single notifier.** Success and failure digests are both built from the run's \`RunResult\` at run end; run observability (history, funnels, log events) is recorded in the per-profile sqlite DB (\`runs\`/\`run_events\` via \`ports/run_store.ts\`), not in files.`; (2) append to the "Local sqlite is the source of truth when `connector: "sqlite"`" bullet: ` Every profile has \`profiles/<name>/data/jobbunny.db\` regardless of connector — runs observability always lives there; a DB failure on a notion-connector profile degrades to a no-op run store, never a failed run.`; (3) in the Commands block after the `board` line add `node src/cli/main.ts runs --profile <name> [show <id>]   # run history from the DB`.
- Modify: `.claude/agents/explainer.md` — update the runner/observability sections: five files → tables, RunFolder checkpoint-only, ctx.runStore, schema v2.
- Modify: `.claude/agents/triager.md` — run-artifact reading now via `jobbunny runs --profile <p>` / `runs show <id>` (checkpoints still in folders until Phase 2).
- Modify: the verify skill file (locate via `grep -rl "rajni" .claude/skills/`) — verification steps read runs rows, not result.json.

**Steps:** apply → `npm run check` → commit `docs: sync CLAUDE.md/explainer/triager/verify for runs-in-DB (pre-approved edits)`.

---

### Task 14: Full gate

- [ ] `npm run check` on the branch, plus `npm run ui:check`, `npm run ui:build`, `npm run ui:e2e`.
- [ ] Grep guard: no source file writes `result.json`, `run.log`, `heartbeat.json`, `failure.json`, or `sync_dryrun.json` (`grep -rn` those literals under `src/` — hits allowed only in comments/tests that assert absence).
- [ ] Commit anything outstanding; branch ready for the review wave.

---

## Execution order

1, 2, 4, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14 (Task 3 depends on Task 4's `ctx.runStore` — see Task 3 Step 3).

## Post-plan gates (owned by the advisor, not this plan)

Review wave + fix round (sdd-task-loop) → live rajni verification per the spec's "Testing and rollout" (with ledger L10's connector/mirror precheck) → PR `feat/db-runs-observability` → `main-everything-db` → advisor merges when green (ledger L2).
