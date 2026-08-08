import type { RunSummary } from '../../lib/api/types';
import { newMatchCount } from '../runs/runResult';

export type MascotState = 'asleep' | 'ears-up' | 'hopping' | 'celebrating';

const CELEBRATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Pure, injectable state selector for the Lapin mascot (spec §3.7/§4).
 * Reads no clock and does no I/O — `now` and every run/result are passed
 * in, which is what makes every branch below exhaustively unit-testable.
 * This is also the exact seam phase 4 of the overall UI revamp replaces
 * once a real `run_intents` table exists: only `queued`'s source changes.
 *
 * Precedence: a currently running run beats a queued one beats a fresh
 * celebration beats the resting default.
 */
export function pickMascotState(input: {
  runs: RunSummary[];
  newestResult: unknown;
  queued: boolean;
  now: number;
}): MascotState {
  const { runs, newestResult, queued, now } = input;

  if (runs.some((run) => run.status === 'running')) return 'hopping';
  if (queued) return 'ears-up';

  const newest = runs.reduce<RunSummary | null>(
    (best, run) => (best === null || run.id > best.id ? run : best),
    null,
  );
  if (newest !== null && newest.status === 'passed' && newest.finishedAt !== null) {
    const finishedAt = Date.parse(newest.finishedAt);
    const isFresh =
      !Number.isNaN(finishedAt) && Math.abs(now - finishedAt) <= CELEBRATE_WINDOW_MS;
    if (isFresh && newMatchCount(newestResult) > 0) return 'celebrating';
  }

  return 'asleep';
}
