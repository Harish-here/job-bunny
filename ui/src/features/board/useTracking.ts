import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  BoardDetailResponse,
  BoardListResponse,
  TrackingPatchBody,
  TrackingPatchResponse,
  TrackingRow,
} from '../../lib/api/types';
import { patchTracking } from './board.api';
import { boardKeys } from './board.queries';
import { applyPatch } from './tracking';

interface Vars {
  jobId: string;
  patch: TrackingPatchBody;
}

interface Ctx {
  previous: TrackingPatchBody;
  write: (row: TrackingRow) => void;
}

/**
 * Reads the current tracking row for a job wherever it's cached: the
 * detail cache when warm, else whichever jobs-list cache holds this row
 * — the Tracker (T9) never mounts `useJob`, and falling back to `null`
 * here would blank every unpatched tracking field (and, on rollback,
 * clear fields a concurrent edit already confirmed).
 */
function readTracking(
  qc: QueryClient,
  profile: string,
  jobId: string,
): TrackingRow | null {
  const detail = qc.getQueryData<BoardDetailResponse>(boardKeys.job(profile, jobId));
  if (detail) return detail.tracking;
  return (
    qc
      .getQueriesData<BoardListResponse>({ queryKey: boardKeys.jobsPrefix(profile) })
      .flatMap(([, list]) => list?.rows ?? [])
      .find((row) => row.id === jobId)?.tracking ?? null
  );
}

export function useTrackingMutation(profile: string) {
  const qc = useQueryClient();
  return useMutation<TrackingPatchResponse, Error, Vars, Ctx>({
    mutationFn: ({ jobId, patch }) => patchTracking(profile, jobId, patch),
    onMutate: async ({ jobId, patch }) => {
      await qc.cancelQueries({ queryKey: boardKeys.job(profile, jobId) });
      await qc.cancelQueries({ queryKey: boardKeys.jobsPrefix(profile) });
      const existing = readTracking(qc, profile, jobId);
      const previous: TrackingPatchBody = {};
      for (const key of Object.keys(patch) as (keyof TrackingPatchBody)[]) {
        previous[key] = (existing?.[key] ?? null) as never;
      }
      const write = (row: TrackingRow) => {
        qc.setQueryData<BoardDetailResponse>(boardKeys.job(profile, jobId), (d) =>
          d ? { ...d, tracking: row } : d,
        );
        qc.setQueriesData<BoardListResponse>(
          { queryKey: boardKeys.jobsPrefix(profile) },
          (list) =>
            list
              ? {
                  ...list,
                  rows: list.rows.map((r) =>
                    r.id === jobId ? { ...r, tracking: row } : r,
                  ),
                }
              : list,
        );
      };
      write(applyPatch(existing, jobId, patch));
      return { previous, write };
    },
    // Rollback is computed against the row AS IT STANDS AT FAILURE TIME
    // (re-read, not the onMutate-time snapshot) so a concurrent edit that
    // already landed and confirmed is never discarded.
    onError: (err, { jobId }, ctx) => {
      if (ctx) {
        const current = readTracking(qc, profile, jobId);
        ctx.write(applyPatch(current, jobId, ctx.previous));
      }
      toast.error(
        `Save failed — rolled back: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
    onSuccess: (res, _vars, ctx) => ctx?.write(res.tracking),
    onSettled: () => qc.invalidateQueries({ queryKey: boardKeys.jobsPrefix(profile) }),
  });
}

/** Field-level edit helper for form inputs: no-op guard + empty→null. */
export function fieldPatch(
  current: TrackingRow | null,
  field: keyof TrackingPatchBody,
  raw: string,
): TrackingPatchBody | null {
  const previous = current?.[field];
  const next = raw.trim();
  if (next === (previous ?? '')) return null;
  return { [field]: next === '' ? null : next } as TrackingPatchBody;
}
