import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { RunSummary } from '../../lib/api/types';
import { parseStageProgress } from '../runs/runProgress';
import { runEventsQuery, runQuery, runsKeys, runsQuery } from '../runs/runs.queries';
import type { RunIntentView } from '../wizard/wizard.types';
import { cancelRunIntent, requestRunIntent } from './intents.api';
import { runControlKeys, runIntentsQuery } from './runcontrol.queries';
import { pickRunControlState, type RunControlState, runControlLabel } from './runState';

export const POLL_INTERVAL_MS = 2500;

export interface RunControlHandle {
  state: RunControlState;
  label: string;
  onRun: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
  error: string | null;
}

/** Reads the SERVER-SHAPE rows straight from the query cache — the "raw
 * data" the poll flag is computed from, deliberately not the derived
 * RunControlState (see this task's brief Rationale). A zero-argument
 * function is a valid `refetchInterval` (TanStack Query calls it with the
 * query object, which every caller below ignores). */
function pollFlag(qc: QueryClient, profile: string): number | false {
  const runs =
    qc.getQueryData<{ rows: RunSummary[] }>(runsKeys.list(profile))?.rows ?? [];
  const intents =
    qc.getQueryData<{ rows: RunIntentView[] }>(runControlKeys.intents(profile))?.rows ??
    [];
  const polling =
    runs.some((r) => r.status === 'running') ||
    intents.some((i) => i.status === 'pending');
  return polling ? POLL_INTERVAL_MS : false;
}

export function useRunControl(profile: string): RunControlHandle {
  const qc = useQueryClient();
  const [conflictRunId, setConflictRunId] = useState<number | null>(null);
  // The runs-query `dataUpdatedAt` at the moment `conflictRunId` was set —
  // the auto-clear effect below only trusts a runs fetch that landed
  // AFTER this, so a stale (pre-conflict) cache read can never instantly
  // erase the conflict state before the freshly-invalidated refetch has
  // even resolved.
  const [conflictSetAt, setConflictSetAt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const runsResult = useQuery({
    ...runsQuery(profile),
    refetchInterval: () => pollFlag(qc, profile),
  });
  const intentsResult = useQuery({
    ...runIntentsQuery(profile),
    refetchInterval: () => pollFlag(qc, profile),
  });

  const runs = runsResult.data?.rows ?? [];
  const intents = intentsResult.data?.rows ?? [];
  const newestId = runs.reduce((max, r) => Math.max(max, r.id), -1);
  const runningId = runs.find((r) => r.status === 'running')?.id ?? -1;

  // A 409 sets `conflictRunId` sticky — `pickRunControlState` itself
  // already prefers a genuinely 'running' run over the conflict state
  // (see its precedence comment), so once the runs list refetch (kicked
  // off below in `runMutation.onSuccess`) reveals that run as 'running',
  // the sidebar already shows 'running', not 'conflict'. This effect only
  // handles what that precedence can't: once the flagged run is no longer
  // 'running' in the runs list at all (finished, or simply absent), the
  // 409 that caused it is stale and must stop masking done/failed/idle —
  // otherwise the sidebar sticks on "Run in progress — view it" until a
  // reload. Keyed on the runs data itself, not a one-shot timer, so it
  // reacts the instant a fresh runs list resolves either way.
  useEffect(() => {
    if (conflictRunId == null) return;
    if (runsResult.dataUpdatedAt <= conflictSetAt) return;
    const stillRunning = runs.some(
      (r) => r.id === conflictRunId && r.status === 'running',
    );
    if (!stillRunning) setConflictRunId(null);
  }, [runs, conflictRunId, conflictSetAt, runsResult.dataUpdatedAt]);

  const detailResult = useQuery({
    ...runQuery(profile, newestId),
    refetchInterval: () => pollFlag(qc, profile),
  });
  const eventsResult = useQuery({
    ...runEventsQuery(profile, runningId),
    refetchInterval: () => pollFlag(qc, profile),
  });

  const progress = parseStageProgress(eventsResult.data?.rows ?? []);

  const state = pickRunControlState({
    runs,
    intents,
    newestResult: detailResult.data?.result,
    progress,
    conflictRunId,
    now: Date.now(),
  });

  const runMutation = useMutation({
    mutationFn: () => requestRunIntent(profile),
    onSuccess: (outcome) => {
      // `requestRunIntent` deliberately never rejects — a fetch failure or
      // an unexpected status resolves as `{ kind: 'error' }` instead — so
      // this branch, not `onError`, is where a failed request must be
      // surfaced. Previously unhandled, it fell into the same path as a
      // real success and was indistinguishable from a queued run.
      if (outcome.kind === 'error') {
        setError(outcome.message);
        return;
      }
      if (outcome.kind === 'run_in_progress') {
        setError(null);
        setConflictRunId(outcome.runId);
        setConflictSetAt(Date.now());
        // So the running run this 409 refers to actually surfaces — see
        // the auto-clear effect above for why this alone is enough for
        // `pickRunControlState`'s own running > conflict precedence to
        // take over once this resolves.
        qc.invalidateQueries({ queryKey: runsKeys.list(profile) });
        return;
      }
      setError(null);
      setConflictRunId(null);
      qc.invalidateQueries({ queryKey: runControlKeys.intents(profile) });
      qc.invalidateQueries({ queryKey: runsKeys.list(profile) });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to start the run.');
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: number) => cancelRunIntent(profile, id),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: runControlKeys.intents(profile) });
      qc.invalidateQueries({ queryKey: runsKeys.list(profile) });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to cancel the run.');
    },
  });

  return {
    state,
    label: runControlLabel(state),
    onRun: () => runMutation.mutate(),
    onCancel: () => {
      if (state.kind === 'queued') cancelMutation.mutate(state.intentId);
    },
    isSubmitting: runMutation.isPending,
    error,
  };
}
