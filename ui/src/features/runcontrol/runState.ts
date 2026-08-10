import type { RunSummary } from '../../lib/api/types';
import { STAGE_ORDER } from '../runs/runProgress';
import { newMatchCount } from '../runs/runResult';
import type { DaemonStatus, RunIntentView } from '../wizard/wizard.types';

export type RunControlState =
  | { kind: 'idle' }
  | { kind: 'queued'; intentId: number }
  | { kind: 'daemon-down'; intentId: number }
  | { kind: 'daemon-unknown'; intentId: number }
  | { kind: 'expired'; intentId: number }
  | { kind: 'running'; runId: number; stage: string | null; index: number; total: number }
  | { kind: 'conflict'; runId: number | null }
  | { kind: 'failed'; runId: number }
  | { kind: 'done'; runId: number; newCount: number };

/** The persistent last-run status line's own state (C15) — decoupled from
 * DONE_WINDOW_MS: the newest finished run's outcome is returned regardless
 * of how long ago it finished, unlike the primary button's windowed
 * done/failed classification below. `finishedAt` is carried so the line's
 * renderer (B26, `RunNowButton.tsx`) can format ux-notes §8's `2h ago`
 * clause without re-deriving it from the raw `runs` list itself. */
export type LastRunStatus =
  | { kind: 'failed'; runId: number; finishedAt: string }
  | { kind: 'done'; runId: number; newCount: number; finishedAt: string }
  | null;

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
 * newest 'pending' intent, refined by the daemon probe — `daemon === null`
 * (probe errored/timed out, per C16 a timeout must read 'unknown', never
 * 'down') -> daemon-unknown; a resolved `DaemonStatus` whose `state !==
 * 'running'` -> daemon-down; otherwise (daemon running, or not yet wired by
 * the caller, `daemon === undefined`) -> queued; else the newest 'expired'
 * intent -> expired (kept as defense-in-depth for the case the daemon
 * check above didn't otherwise resolve the state); else the newest run,
 * when it finished within DONE_WINDOW_MS, gives failed (status
 * 'failed'/'crashed') or done (status 'passed'); else idle. Pure — now and
 * every run/intent/result are parameters. See `pickLastRunStatus` for the
 * persistent status line, which is NOT gated by DONE_WINDOW_MS.
 */
export function pickRunControlState(input: {
  runs: RunSummary[];
  intents: RunIntentView[];
  newestResult: unknown;
  progress: { stage: string; index: number; total: number } | null;
  conflictRunId: number | null | undefined;
  now: number;
  daemon?: DaemonStatus | null;
}): RunControlState {
  const { runs, intents, newestResult, progress, conflictRunId, now, daemon } = input;

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
  if (pending) {
    if (daemon === null) return { kind: 'daemon-unknown', intentId: pending.id };
    if (daemon && daemon.state !== 'running') {
      return { kind: 'daemon-down', intentId: pending.id };
    }
    return { kind: 'queued', intentId: pending.id };
  }

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

/**
 * The persistent last-run status line's data (C15): the newest run's
 * failed/done outcome, independent of DONE_WINDOW_MS. Decoupled from
 * `pickRunControlState` on purpose — that function's own 'failed'/'done'
 * cases remain windowed for the primary button's idle/queued/running
 * state, which stays a separate rendering concern (B26).
 */
export function pickLastRunStatus(input: {
  runs: RunSummary[];
  newestResult: unknown;
}): LastRunStatus {
  const { runs, newestResult } = input;
  const newestRun = newestById(runs);
  if (!newestRun || newestRun.finishedAt === null) return null;
  if (newestRun.status === 'failed' || newestRun.status === 'crashed') {
    return { kind: 'failed', runId: newestRun.id, finishedAt: newestRun.finishedAt };
  }
  if (newestRun.status === 'passed') {
    return {
      kind: 'done',
      runId: newestRun.id,
      newCount: newMatchCount(newestResult),
      finishedAt: newestRun.finishedAt,
    };
  }
  return null;
}

export function runControlLabel(state: RunControlState): string {
  switch (state.kind) {
    case 'idle':
      return 'Run now';
    case 'queued':
      return 'Queued (waiting for daemon)';
    case 'daemon-down':
      return "Daemon isn't running";
    case 'daemon-unknown':
      return "Can't reach the daemon — queued anyway";
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
