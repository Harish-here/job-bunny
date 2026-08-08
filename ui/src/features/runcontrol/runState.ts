import type { RunSummary } from '../../lib/api/types';
import { STAGE_ORDER } from '../runs/runProgress';
import { newMatchCount } from '../runs/runResult';
import type { RunIntentView } from '../wizard/wizard.types';

export type RunControlState =
  | { kind: 'idle' }
  | { kind: 'queued'; intentId: number }
  | { kind: 'expired'; intentId: number }
  | { kind: 'running'; runId: number; stage: string | null; index: number; total: number }
  | { kind: 'conflict'; runId: number | null }
  | { kind: 'failed'; runId: number }
  | { kind: 'done'; runId: number; newCount: number };

export const DONE_WINDOW_MS = 10 * 60 * 1000;

function newestById<T extends { id: number }>(rows: T[]): T | null {
  return rows.reduce<T | null>(
    (best, row) => (best === null || row.id > best.id ? row : best),
    null,
  );
}

/**
 * Precedence, top to bottom: a run whose status is 'running' -> running;
 * else a conflictRunId set by the most recent 409 -> conflict; else the
 * newest 'pending' intent -> queued; else the newest 'expired' intent ->
 * expired; else the newest run, when it finished within DONE_WINDOW_MS,
 * gives failed (status 'failed'/'crashed') or done (status 'passed');
 * else idle. Pure — now and every run/intent/result are parameters.
 */
export function pickRunControlState(input: {
  runs: RunSummary[];
  intents: RunIntentView[];
  newestResult: unknown;
  progress: { stage: string; index: number; total: number } | null;
  conflictRunId: number | null | undefined;
  now: number;
}): RunControlState {
  const { runs, intents, newestResult, progress, conflictRunId, now } = input;

  const runningRun = newestById(runs.filter((r) => r.status === 'running'));
  if (runningRun) {
    return {
      kind: 'running',
      runId: runningRun.id,
      stage: progress?.stage ?? null,
      index: progress?.index ?? 0,
      total: progress?.total ?? STAGE_ORDER.length,
    };
  }

  if (conflictRunId != null) {
    return { kind: 'conflict', runId: conflictRunId };
  }

  const pending = newestById(intents.filter((i) => i.status === 'pending'));
  if (pending) return { kind: 'queued', intentId: pending.id };

  const expired = newestById(intents.filter((i) => i.status === 'expired'));
  if (expired) return { kind: 'expired', intentId: expired.id };

  const newestRun = newestById(runs);
  if (newestRun && newestRun.finishedAt !== null) {
    const finishedAt = Date.parse(newestRun.finishedAt);
    const withinWindow =
      !Number.isNaN(finishedAt) && Math.abs(now - finishedAt) <= DONE_WINDOW_MS;
    if (withinWindow) {
      if (newestRun.status === 'failed' || newestRun.status === 'crashed') {
        return { kind: 'failed', runId: newestRun.id };
      }
      if (newestRun.status === 'passed') {
        return {
          kind: 'done',
          runId: newestRun.id,
          newCount: newMatchCount(newestResult),
        };
      }
    }
  }

  return { kind: 'idle' };
}

export function runControlLabel(state: RunControlState): string {
  switch (state.kind) {
    case 'idle':
      return 'Run now';
    case 'queued':
      return 'Queued (waiting for daemon)';
    case 'expired':
      return "Daemon isn't running";
    case 'running':
      return state.stage === null
        ? 'Running — starting…'
        : `Running — ${state.stage} ${state.index}/${state.total}`;
    case 'conflict':
      return 'Run in progress — view it';
    case 'failed':
      return 'Last run failed';
    case 'done':
      return `Done: ${state.newCount} new`;
  }
}
