import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
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
      if (outcome.kind === 'run_in_progress') {
        setConflictRunId(outcome.runId);
        return;
      }
      setConflictRunId(null);
      qc.invalidateQueries({ queryKey: runControlKeys.intents(profile) });
      qc.invalidateQueries({ queryKey: runsKeys.list(profile) });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: number) => cancelRunIntent(profile, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: runControlKeys.intents(profile) });
      qc.invalidateQueries({ queryKey: runsKeys.list(profile) });
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
  };
}
