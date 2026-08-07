import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/skeleton';
import { ApiError } from '../../lib/api/client';
import { RunDetailView } from './RunDetailView';
import { RunsList } from './RunsList';
import { useRun, useRunEvents, useRuns } from './useRunsData';

const SKELETON_ROW_KEYS = ['s1', 's2', 's3'];

function isNoLocalDb(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'no_local_db';
}

/** Shared list-pane/detail-pane error state — same shape TriagePage uses. */
function ErrorRetry({
  message,
  onRetry,
  padded = false,
}: {
  message: string;
  onRetry: () => void;
  padded?: boolean;
}) {
  return (
    <div className={`flex flex-col items-start gap-2 text-sm ${padded ? 'p-4' : ''}`}>
      <span className="text-destructive">{message}</span>
      <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** Read-only runs history (persist-to-db Phase 1, T11): a master list of
 * `runs` rows on the left, the selected run's funnel + events on the
 * right. No polling — a manual Refresh button is the only way to see new
 * rows, matching the brief's "no polling beyond manual refresh". */
export function RunsPage({ profile }: { profile: string }) {
  const runsQuery = useRuns(profile);
  const rows = runsQuery.data?.rows ?? [];
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Default-select the newest run once the list resolves, mirroring
  // TriagePage's first-row default — never overrides a user's own pick.
  useEffect(() => {
    if (selectedId === null && rows.length > 0) {
      setSelectedId(rows[0]?.id ?? null);
    }
  }, [rows, selectedId]);

  const detailQuery = useRun(profile, selectedId ?? -1);
  const eventsQuery = useRunEvents(profile, selectedId ?? -1);

  const noLocalDb = isNoLocalDb(runsQuery.error);
  const isError = runsQuery.isError && !noLocalDb;
  const detail =
    selectedId !== null && detailQuery.data?.id === selectedId
      ? detailQuery.data
      : undefined;
  const events = eventsQuery.data?.rows ?? [];

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center justify-between border-b p-3">
        <h1 className="text-lg font-semibold font-heading">Runs</h1>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => runsQuery.refetch()}
        >
          Refresh
        </Button>
      </div>
      <div className="grid flex-1 grid-cols-[minmax(280px,360px)_1fr] overflow-hidden">
        <section className="overflow-y-auto border-r">
          {noLocalDb ? (
            <div className="p-4 text-sm text-muted-foreground">
              This profile has no local database yet — run the pipeline to populate one.
            </div>
          ) : isError ? (
            <ErrorRetry
              padded
              message="Couldn't load runs — the board server may be unreachable."
              onRetry={() => runsQuery.refetch()}
            />
          ) : runsQuery.isPending ? (
            <div className="flex flex-col gap-2 p-3">
              {SKELETON_ROW_KEYS.map((key) => (
                <Skeleton key={key} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <RunsList rows={rows} selectedId={selectedId} onSelect={setSelectedId} />
          )}
        </section>

        <section className="overflow-y-auto p-6">
          {noLocalDb ? (
            <div className="text-muted-foreground">No runs to show.</div>
          ) : isError ? (
            <ErrorRetry
              message="Couldn't load runs — the board server may be unreachable."
              onRetry={() => runsQuery.refetch()}
            />
          ) : selectedId !== null && (detailQuery.isError || eventsQuery.isError) ? (
            <ErrorRetry
              message="Couldn't load this run — the board server may be unreachable."
              onRetry={() => {
                detailQuery.refetch();
                eventsQuery.refetch();
              }}
            />
          ) : detail ? (
            <RunDetailView run={detail} events={events} />
          ) : (
            <div className="text-muted-foreground">
              {rows.length === 0 ? 'No run selected.' : 'Select a run to see details.'}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
