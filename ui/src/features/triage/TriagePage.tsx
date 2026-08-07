import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Skeleton } from '../../components/ui/skeleton';
import { ApiError } from '../../lib/api/client';
import type { ListQuery } from '../../lib/api/types';
import { useJob, useJobs, useMeta } from '../board/useBoardData';
import { useTrackingMutation } from '../board/useTracking';
import { JdText } from '../job/JdText';
import { JobFacts } from '../job/JobFacts';
import { JobHeader } from '../job/JobHeader';
import { TrackingPanel } from '../job/TrackingPanel';
import { DecideBar } from './DecideBar';
import { DECIDE_STATUS, type DecideAction, nextUndecided } from './decide';
import { FilterPopover } from './FilterPopover';
import { JobList } from './JobList';
import { useTriageSelection } from './selection';
import { useTriageKeyboard } from './useTriageKeyboard';

const DEFAULT_QUERY: ListQuery = {
  sort: 'date_found',
  order: 'desc',
  archived: 'false',
  limit: 50,
  offset: 0,
};

const SEARCH_DEBOUNCE_MS = 250;
const SKELETON_ROW_KEYS = ['s1', 's2', 's3', 's4', 's5', 's6'];

function isNoLocalDb(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'no_local_db';
}

/** Shared shape for the list-pane and detail-pane error states — text
 * copy plus a Retry button wired to the failed query's own `refetch`. */
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

export function TriagePage({ profile }: { profile: string }) {
  const [query, setQuery] = useState<ListQuery>(DEFAULT_QUERY);
  const [companyDraft, setCompanyDraft] = useState('');

  const metaQuery = useMeta(profile);
  const jobsQuery = useJobs(profile, query);
  const rows = useMemo(() => jobsQuery.data?.rows ?? [], [jobsQuery.data]);
  const { selectedId, select, move } = useTriageSelection(rows);
  const detailQuery = useJob(profile, selectedId ?? '');
  const trackingMutation = useTrackingMutation(profile);

  function decide(action: DecideAction): void {
    if (selectedId === null) return;
    const jobId = selectedId;
    trackingMutation.mutate({ jobId, patch: { status: DECIDE_STATUS[action] } });
    select(nextUndecided(rows, jobId) ?? jobId);
  }

  useTriageKeyboard({ move, onDecide: decide, selectedId });

  // The `/` hotkey target (T7) — an always-mounted plain Input, never inside
  // the Popover — debounced into the company filter.
  useEffect(() => {
    const handle = setTimeout(() => {
      setQuery((q) => ({ ...q, company: companyDraft.trim() || undefined, offset: 0 }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [companyDraft]);

  function patchFilters(patch: Partial<ListQuery>): void {
    setQuery((q) => ({ ...q, ...patch, offset: 0 }));
  }

  function setOffset(offset: number): void {
    setQuery((q) => ({ ...q, offset }));
  }

  function toggleSort(field: 'date_found' | 'score'): void {
    setQuery((q) =>
      q.sort === field
        ? { ...q, order: q.order === 'asc' ? 'desc' : 'asc', offset: 0 }
        : { ...q, sort: field, order: 'desc', offset: 0 },
    );
  }

  const undecidedCount = rows.filter((row) => row.tracking?.status == null).length;
  const total = jobsQuery.data?.total ?? 0;
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  const noLocalDb = isNoLocalDb(jobsQuery.error);
  const isError = jobsQuery.isError && !noLocalDb;
  // Guards the brief window before `useTriageSelection`'s effect resolves the
  // first row: `useJob` fires once with an empty id (Hooks must be called
  // unconditionally), and its response must never be mistaken for the
  // currently-selected job's detail.
  const detail =
    selectedId !== null && detailQuery.data?.id === selectedId
      ? detailQuery.data
      : undefined;

  return (
    <div className="grid h-screen grid-cols-[minmax(280px,360px)_1fr]">
      <section className="flex flex-col overflow-y-auto border-r">
        <div className="flex flex-col gap-2 border-b p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-attention-strong">
              {undecidedCount} undecided
            </span>
            <FilterPopover
              query={query}
              statusOptions={metaQuery.data?.statusOptions ?? []}
              excitementOptions={metaQuery.data?.excitementOptions ?? []}
              onChange={patchFilters}
            />
          </div>
          <Input
            data-search-input
            aria-label="Search company"
            placeholder="Search company…"
            value={companyDraft}
            onChange={(e) => setCompanyDraft(e.target.value)}
          />
          <div className="flex gap-1">
            <Button
              type="button"
              variant={query.sort === 'score' ? 'ghost' : 'secondary'}
              size="sm"
              className="hop"
              onClick={() => toggleSort('date_found')}
            >
              Date {query.sort !== 'score' && (query.order === 'asc' ? '↑' : '↓')}
            </Button>
            <Button
              type="button"
              variant={query.sort === 'score' ? 'secondary' : 'ghost'}
              size="sm"
              className="hop"
              onClick={() => toggleSort('score')}
            >
              Score {query.sort === 'score' && (query.order === 'asc' ? '↑' : '↓')}
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {noLocalDb ? (
            <div className="p-4 text-sm text-muted-foreground">
              This profile has no local database yet — run the pipeline to populate one.
            </div>
          ) : isError ? (
            <ErrorRetry
              padded
              message="Couldn't load jobs — the board server may be unreachable."
              onRetry={() => jobsQuery.refetch()}
            />
          ) : jobsQuery.isPending ? (
            <div className="flex flex-col gap-2 p-3">
              {SKELETON_ROW_KEYS.map((key) => (
                <Skeleton key={key} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <JobList rows={rows} selectedId={selectedId} onSelect={select} />
          )}
        </div>

        {!noLocalDb && total > limit && (
          <div className="flex items-center justify-between border-t p-2 text-sm">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="hop"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(offset - limit, 0))}
            >
              Prev
            </Button>
            <span className="text-muted-foreground">
              {offset + 1}–{Math.min(offset + limit, total)} of {total}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="hop"
              disabled={offset + limit >= total}
              onClick={() => setOffset(offset + limit)}
            >
              Next
            </Button>
          </div>
        )}
      </section>

      <section className="overflow-y-auto p-6">
        {noLocalDb ? (
          <div className="text-muted-foreground">No jobs to show.</div>
        ) : isError ? (
          <ErrorRetry
            message="Couldn't load jobs — the board server may be unreachable."
            onRetry={() => jobsQuery.refetch()}
          />
        ) : selectedId !== null && detailQuery.isError ? (
          <ErrorRetry
            message="Couldn't load this job — the board server may be unreachable."
            onRetry={() => detailQuery.refetch()}
          />
        ) : detail ? (
          <div className="flex flex-col gap-6">
            <JobHeader job={detail} />
            <DecideBar job={detail} onDecide={decide} />
            <JobFacts job={detail} />
            <JdText jd={detail.jd} />
            <TrackingPanel profile={profile} job={detail} />
          </div>
        ) : (
          <div className="text-muted-foreground">
            {rows.length === 0 ? 'No job selected.' : 'Select a job to see details.'}
          </div>
        )}
      </section>
    </div>
  );
}
