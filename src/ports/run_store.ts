/** Run observability store (persist-to-db Phase 1). Writer side: runner +
 * CLI drivers. Reader side: board + `jobbunny runs` CLI + cleanup. Sync by
 * design — node:sqlite is sync (mirrors ports/board.ts). WRITER methods are
 * fail-soft in implementations: a failure warns once on stderr and never
 * throws (observability must never red a run). */
export type RunKind = 'run' | 'stage' | 'reconcile' | 'catchup';
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
  progress: RunProgress | null;
  catchupSlots: string[] | null;
}

/** Per-run, per-stage progress (persist-to-db R3). One row per run, upserted
 * on every stage transition. `itemCurrent`/`itemTotal` are nullable from day
 * one — future within-stage counters fill these in with no further schema
 * change (spec AC5). */
export interface RunProgress {
  stage: string;
  stageIndex: number;
  stageTotal: number;
  stageStartedAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC — last write, also a per-stage heartbeat
  itemCurrent: number | null;
  itemTotal: number | null;
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
    catchupSlots?: string[];
  }): number;
  /** Batched insert, one transaction. Also bumps heartbeat_at. */
  appendEvents(runId: number, events: RunEventRow[]): void;
  heartbeat(runId: number, at: string): void;
  /** Upserts the run's current stage progress. Same fail-soft contract as
   * every other writer method on this port (file header). */
  recordProgress(
    runId: number,
    progress: {
      stage: string;
      stageIndex: number;
      stageTotal: number;
      stageStartedAt: string;
    },
  ): void;
  recordFailure(runId: number, failure: RunFailure): void;
  recordSyncDryrun(runId: number, report: unknown): void;
  finishRun(
    runId: number,
    outcome: 'passed' | 'failed',
    result: unknown,
    finishedAt: string,
  ): void;
}

export interface RunStoreReader {
  listRuns(opts?: { limit?: number; offset?: number }): RunSummary[];
  getRun(id: number): RunDetail | null;
  listEvents(runId: number, opts?: { limit?: number; offset?: number }): RunEventRow[];
  /** id of the run row recorded for runs/<date>/<timeDir>, or null. */
  findRunId(date: string, timeDir: string): number | null;
  /** Every distinct non-null `time_dir` recorded for `date`, across every
   * `kind` — the daemon's OWN durable owed-slot evidence (`ops/daemon`):
   * a `runs` row is written the instant an invocation opens (`startRun`,
   * before any checkpoint exists), so this survives a daemon restart in a
   * way the pidfile's own attempts ledger never can. Fail-soft like every
   * other reader here: an open/query failure returns `[]`, never throws. */
  listRunTimeDirs(date: string): string[];
  /** Deletes runs (+ their events) with date strictly older than
   * today − ttlDays; never today's. Returns the number of runs deleted. */
  pruneRunsOlderThan(today: string, ttlDays: number): number;
  /** True iff a run of `kind` exists for `date` — durable (survives daemon
   * restart AND day rollover), unlike the pidfile's attempts ledger, which
   * is pruned to only today's entries (D19's "A9" comment) and resets on
   * every `serve stop`/`start`. Added for step 1.11a's retrospective sweep:
   * "did a catch-up actually run for a PAST date" cannot be answered from
   * the pidfile at all once the date has rolled over — `runs` can. */
  hasRunOfKind(date: string, kind: RunKind): boolean;
}

export interface RunStore extends RunStoreWriter, RunStoreReader {
  close(): void;
}
