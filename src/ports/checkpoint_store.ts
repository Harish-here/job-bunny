/** Checkpoint store (persist-to-db Phase 2) — per-invocation stage-output
 * snapshots, keyed by (runDate, timeDir, position). Writer: the runner
 * (`pipeline/runner/run.ts`) and the `stage` CLI driver. Reader: the same
 * two, for `--resume`/chain continuation. Sync by design — node:sqlite is
 * sync (mirrors `ports/run_store.ts`/`ports/board.ts`).
 *
 * LOUD, unlike `RunStore`: `write` THROWS on failure. Checkpoints are
 * recovery data — silently losing one turns a resumable failure into a
 * from-scratch rerun, so (unlike the run-observability store's permanent
 * fail-soft degradation) a checkpoint write failure must fail the run.
 * Payloads are opaque `unknown` (ports-only-core forbids importing
 * `StagePayload`/pipeline types here — same posture as `RunStore`'s
 * `result`/`failure` blobs). */
export interface CheckpointRef {
  runDate: string;
  timeDir: string;
  position: number;
  stage: string;
  /** The `runs` row id of the invocation that WROTE this checkpoint —
   * provenance, and a join key back to that row's own log/result/failure.
   * Absent when the writer never opened a `runs` row (e.g. `ctx.runId` is
   * unset); the adapter persists that absence as `NULL`, never a sentinel
   * like `-1`. */
  writtenBy?: number;
}

export interface CheckpointStore {
  /** Upserts this (runDate, timeDir, position) slot — a rerun of the same
   * stage at the same position in the same group OVERWRITES it (matches
   * the file era's same-filename overwrite behavior). THROWS on any
   * failure — never swallow, never degrade to a no-op. */
  write(ref: CheckpointRef, payload: unknown): void;
  /** The highest-`position` row for this group, or `undefined` if the
   * group has no checkpoints yet (e.g. a killed run before its first
   * checkpoint, or a group that exists only as a `runs` row). */
  readLatest(
    runDate: string,
    timeDir: string,
  ): { ref: CheckpointRef; payload: unknown } | undefined;
  /** Lexicographically greatest `time_dir` for `runDate` across BOTH
   * `checkpoints` and `runs` — a group exists if EITHER table mentions
   * it, so an early-killed run (a `runs` row with no checkpoints yet)
   * still occupies its `HH-MM` slot. `undefined` when neither table has
   * any row for that date.
   *
   * COLLISION-AVOIDANCE ONLY (`nextTimeDir`'s own reason for existing) —
   * do NOT use this for resume/chain-continuation group discovery. A
   * caller that needs "the latest group with an actual payload to resume
   * from" must use `latestCheckpointTimeDir` instead: a bare `runs` row
   * (no checkpoint written yet — e.g. a run that opened, then died before
   * its first stage completed) would otherwise SHADOW the last group that
   * genuinely holds a payload, silently losing a resumable checkpoint. */
  latestTimeDir(runDate: string): string | undefined;
  /** The greatest `time_dir` for `runDate` that has AT LEAST ONE row in
   * `checkpoints` — never a bare `runs` row. `undefined` when this date
   * has no checkpoints at all. THE resume/chain-continuation discovery
   * method: `run.ts`'s `--resume`, `stage.ts`'s same-day chain, and
   * `reconcile.ts`'s same-day chain all use this (never `latestTimeDir`)
   * so a group that only ever opened a `runs` row — died before writing
   * anything resumable — is skipped in favor of the last group that
   * actually has a payload. */
  latestCheckpointTimeDir(runDate: string): string | undefined;
  /** `time` itself, or `time`-2, `time`-3, … — the first candidate absent
   * from the same (`checkpoints` ∪ `runs`) time_dir set for `runDate`. */
  nextTimeDir(runDate: string, time: string): string;
  /** Deletes checkpoint ROWS (not groups) with `run_date` strictly older
   * than `todayDate` − `ttlDays`; never today's. Returns the number of
   * rows deleted.
   *
   * LOUD like `write`/`readLatest` above by the port's own contract — but
   * unlike those two (which sit on the run's own recovery path, where
   * silently losing a checkpoint would turn a resumable failure into a
   * from-scratch rerun), this is TTL housekeeping run post-sync from
   * `routines/cleanup/cleanup.ts`. That caller deliberately wraps this
   * call in its own try/catch and warns rather than lets it propagate —
   * a full run that already PASSED must never red out (and swallow its
   * own success digest) over a background prune failing. The two postures
   * (recovery-path LOUD vs. housekeeping-caller-catches-LOUD) are both
   * deliberate; keep them that way rather than reconciling to one. */
  pruneOlderThan(todayDate: string, ttlDays: number): number;
  close(): void;
}
