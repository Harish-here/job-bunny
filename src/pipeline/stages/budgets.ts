/**
 * pipeline/stages/budgets.ts — a plain data mirror of every stage
 * factory's own `timeoutMs`/`retries` (see each `pipeline/stages/*.ts`
 * file for the source of truth), plus the arithmetic that turns that
 * table into a run-level cap.
 *
 * Why a static table rather than calling the real stage factories at
 * runtime: this module is consumed by `serve` (Task 9), which is
 * cross-profile (D6) and therefore cannot `wire()` a real profile to
 * obtain a live `stages` array the way `cli/commands/run.ts` does for
 * itself. Reading a static table from PRODUCTION code — rather than
 * constructing stage factories with never-invoked stub ports at
 * runtime — keeps this module honest: it holds no fragile assumption
 * about what a stage factory does at construction time.
 *
 * The cost of that simplicity is that this table can silently drift
 * from the real per-stage `timeoutMs`/`retries` if a stage factory
 * changes without a matching edit here. `test/invariants/
 * stage_budgets.test.ts` closes that gap — it is the one place the
 * fragile stub-port construction trick is still used, deliberately
 * confined to a test so an unmirrored change fails loudly in CI, not
 * silently in a running daemon (see that file's own header for the
 * full rationale).
 */
export interface StageBudget {
  name: string;
  timeoutMs: number;
  retries: number;
}

/** Margin over the raw worst-case stage-timeout sum, to absorb
 * orchestration overhead (checkpoint writes between batches,
 * stall-watchdog polling, process scheduling jitter) that isn't itself
 * charged against any one stage's `timeoutMs`. Same figure and same
 * rationale `cli/commands/run.ts` previously defined as a private
 * local constant — this is now its one home. */
export const RUN_CAP_MARGIN = 1.25;

/** Verified against every `pipeline/stages/*.ts` factory's real
 * `name`/`timeoutMs`/`retries`, in pipeline order. Kept honest by
 * `test/invariants/stage_budgets.test.ts`. */
export const STAGE_BUDGETS: readonly StageBudget[] = [
  { name: 'reconcile', timeoutMs: 60_000, retries: 0 },
  { name: 'farm', timeoutMs: 5_400_000, retries: 0 },
  { name: 'source', timeoutMs: 300_000, retries: 0 },
  { name: 'compress', timeoutMs: 30_000, retries: 0 },
  { name: 'structure', timeoutMs: 1_800_000, retries: 1 },
  { name: 'assemble', timeoutMs: 30_000, retries: 0 },
  { name: 'filter', timeoutMs: 30_000, retries: 0 },
  { name: 'dedup', timeoutMs: 30_000, retries: 0 },
  { name: 'rank', timeoutMs: 30_000, retries: 0 },
  { name: 'sync', timeoutMs: 900_000, retries: 0 },
];

/**
 * The run-level cap (third watchdog layer, `runPipeline`'s `runCapMs`)
 * MUST exceed the worst case total every stage could legitimately
 * take, including whole-stage retries — each retry attempt gets its
 * OWN fresh `timeoutMs` budget (`guardStage`/`runOneAttempt`), so a
 * stage with `retries: 1` can legitimately consume `timeoutMs * 2`
 * before the run itself should even consider that a problem.
 */
export function computeRunCapMs(budgets: readonly StageBudget[] = STAGE_BUDGETS): number {
  const worstCaseMs = budgets.reduce((sum, b) => sum + b.timeoutMs * (b.retries + 1), 0);
  return Math.ceil(worstCaseMs * RUN_CAP_MARGIN);
}
