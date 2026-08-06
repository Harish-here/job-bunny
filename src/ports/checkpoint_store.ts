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
   * any row for that date. */
  latestTimeDir(runDate: string): string | undefined;
  /** `time` itself, or `time`-2, `time`-3, … — the first candidate absent
   * from the same (`checkpoints` ∪ `runs`) time_dir set for `runDate`. */
  nextTimeDir(runDate: string, time: string): string;
  /** Deletes checkpoint ROWS (not groups) with `run_date` strictly older
   * than `todayDate` − `ttlDays`; never today's. Returns the number of
   * rows deleted. */
  pruneOlderThan(todayDate: string, ttlDays: number): number;
  close(): void;
}
