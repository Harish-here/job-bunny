# Phase 2 design — checkpoints → per-profile sqlite DB

Part of the persist-to-db program (see `2026-08-05-persist-to-db-umbrella-design.md`, decision D2: checkpoints move in Phase 2). Builds directly on Phase 1's schema v2 (`runs`/`run_events`) and its `runs` PR. Author: advisor (overnight authorization, ledger L3/L7); status: approved for execution under the same authorization.

## Goal

Retire the per-run checkpoint files (`profiles/<name>/data/runs/<date>/<HH-MM>/NN-<stage>.json`) — the only thing left in the run-folder tree after Phase 1 — and store checkpoints in `jobbunny.db`, preserving every resume semantic exactly. After this phase a run creates **no files** under `profiles/<name>/data/runs/`.

## Semantics that MUST be preserved (from `run_folder.ts`, `run.ts`, `stage.ts`)

1. **Per-invocation checkpoint group.** A full `run` owns a fresh group (today's `HH-MM`, `-N` suffix on collision); checkpoints are per-run, never last-writer-wins per day.
2. **Stage chains share a group.** `stage <name>` continues in TODAY's latest existing group (creating one only when today has none), reads the group's highest-position checkpoint as input (seed `{jobs:[],dropped:[]}` when none), and writes its own slot — so `stage filter` → `stage dedup` → `stage rank` hand off state. A rerun of the same stage in the same group **overwrites** its slot (file behavior: same filename).
3. **`run --resume`** seeds from the latest EARLIER same-day group's highest checkpoint (`startIndex = position + 1`), never its own.
4. **Atomicity.** A killed process never leaves a torn checkpoint (today: temp+rename; tomorrow: one INSERT in a transaction).
5. **Fail-LOUD.** Unlike the run store's fail-soft posture, a checkpoint write failure must fail the run — checkpoints are recovery data, and silently losing one turns a resumable failure into a from-scratch rerun. This is parity: `writeCheckpoint` throwing already fails the run today.

## Key design decision: group key is `(run_date, time_dir)`, not `run_id`

Phase 1's `runs` rows already record `run_date` + `time_dir`, and **multiple stage-run rows share one `time_dir`** — that sharing IS the stage-chain hand-off. Keying checkpoints by `run_id` would silently break semantic 2. So:

```sql
-- migration v3 (forward-only, appended to MIGRATIONS)
CREATE TABLE checkpoints (
  run_date   TEXT    NOT NULL,
  time_dir   TEXT    NOT NULL,
  position   INTEGER NOT NULL,
  stage      TEXT    NOT NULL,
  payload_json TEXT  NOT NULL,
  written_by INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL,
  PRIMARY KEY (run_date, time_dir, position)
) WITHOUT ROWID;
CREATE INDEX idx_checkpoints_date ON checkpoints(run_date);
```

`INSERT OR REPLACE` gives slot-overwrite (semantic 2's rerun case). `written_by` is provenance only — never used for lookup.

## Port

`ports/checkpoint_store.ts` (flat file, `ports/index.ts` barrel, payloads stay opaque `unknown` — same ports-only-core posture as `run_store.ts`):

```ts
interface CheckpointRef { runDate: string; timeDir: string; position: number; stage: string; }
interface CheckpointStore {
  write(ref: CheckpointRef, payload: unknown): void;            // throws on failure (loud)
  readLatest(runDate: string, timeDir: string): { ref: CheckpointRef; payload: unknown } | undefined;
  latestTimeDir(runDate: string): string | undefined;           // groups with ≥1 checkpoint OR a runs row
  nextTimeDir(runDate: string, time: string): string;           // collision suffix via runs+checkpoints existence
  pruneOlderThan(todayDate: string, ttlDays: number): number;
  close(): void;
}
```

Adapter `adapters/db/sqlite/checkpoints/` shares the same DB file/open path as the run store (one `jobbunny.db`); construction wired ONLY in `cli/wire/compose.ts`; `PipelineCtx` gains `checkpointStore`. Loud posture means NO lazy-open no-op fallback here: if the DB can't open when the first checkpoint is written, the run fails — same as a full disk today. (`doctor` still never creates the DB.)

- `latestTimeDir`/`nextTimeDir` move from directory scans to DB queries over `runs` ∪ `checkpoints` time_dirs — a group exists if either table mentions it, so an early-killed run (row, no checkpoints yet) still occupies its `HH-MM` and still collides suffixes correctly.
- `runner/run.ts` (`runPipeline`) takes the store + `{date, timeDir}` instead of a `RunFolder`; `resumeFrom.checkpointPath` becomes a human-readable descriptor (`"<date>/<timeDir>#<position>-<stage>"`) — it is display/log-only today (verify by grep before changing the type).
- `RunFolder` is deleted; `formatRunTime` survives (pure time formatting); `ops/observability/run/` keeps `result.ts` and the time helpers that remain pure.
- `routine cleanup`: prune `checkpoints` by `run_date` with the same TTL as runs rows, and KEEP the legacy `runs/<date>/` folder pruning for pre-Phase-2 leftovers (harmless when absent; removal is a later cleanup).

## No backfill (umbrella D7, ledger L9 assessed)

Checkpoints are same-day ephemera — resume never looks past today. No file→DB import; consequence (documented in the PR): upgrading mid-day drops that day's resumability once, nothing else. L9's import obligation targets durable pipeline state (Phase 3) and config (Phase 4), not checkpoints.

## CLAUDE.md

The "Uniform checkpoints" bullet becomes false after this phase. Proposed replacement text is recorded in the ledger and the PR body for the user's approval; per the standing instruction-file rule (no pre-approval exists for Phase 2 text), CLAUDE.md is NOT edited in this phase — the sync lands as a one-line follow-up once approved. Explainer KB / triager / verify skill (repo-convention docs-as-code, previously synced without pre-approval) are updated in-phase.

## Testing and rollout

- Colocated unit tests: migration v3, checkpoint CRUD + slot overwrite, group discovery (latest/next incl. `-N` collisions and row-without-checkpoints groups), loud-failure posture, cleanup pruning, runner/driver integration against a fake store.
- **Live verification before merge** (rajni, L10 precheck): (a) stage chain `filter → dedup → rank` hands off through DB rows in ONE group; (b) kill a run mid-stage, then `run --resume` seeds from the killed group's latest checkpoint at the right `startIndex`; (c) a full staged run creates zero files under `profiles/rajni/data/runs/`; (d) fresh DB migrates v0→v3 cleanly.
- Kill-and-resume is THE gate for this phase (highest-risk semantic).
