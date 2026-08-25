import { useQueries, useQueryClient } from '@tanstack/react-query';
import { WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatRelative } from '../../../../src/core/datetime/index.ts';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/skeleton';
import { ApiError } from '../../lib/api/client';
import type { RunDetail, RunSummary, SoftErrorSummary } from '../../lib/api/types';
import { useRunControl } from '../runcontrol/useRunControl';
import { ErrorRetry } from '../shared/ErrorRetry';
import { DeferredGroup } from './DeferredGroup';
import { LiveRunHeader } from './LiveRunHeader';
import { RunDetailView } from './RunDetailView';
import { RunsList } from './RunsList';
import { classifyOutcome } from './runOutcome';
import { runQuery, runsKeys } from './runs.queries';
import {
  useDeferredSlots,
  useRun,
  useRunEvents,
  useRuns,
  useSoftErrors,
} from './useRunsData';

const SKELETON_ROW_KEYS = ['s1', 's2', 's3'];
const LIVE_POLL_MS = 2500;

function isNoLocalDb(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'no_local_db';
}

/** Local calendar date as `YYYY-MM-DD` — the SAME local-date convention
 * `core/schedule/types.ts`'s `formatLocalDate` uses (and the daemon relies
 * on) but reimplemented here rather than imported: per this task's own
 * brief, `core/schedule` is not one of the zero-import `core/` modules the
 * UI is allowed to import at runtime (only `core/datetime`, which has no
 * today-formatter), so the handful of local getters are duplicated instead.
 * Exported so `RunsPage.test.tsx` can compute the same "today" its
 * assertions need without re-deriving the logic a second, divergent way. */
export function todayLocalDate(): string {
  const d = new Date();
  const yyyy = String(d.getFullYear()).padStart(4, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Header freshness chip (R11, B23): reads `dataUpdatedAt`/`isError` off the
 * runs-list query the page already polls — no dedicated poll of its own.
 * Mirrors ux-notes §9's "Stalled ≠ disconnected" split at the strip level:
 * an `isError` poll is "we cannot tell" and gets its own wording, never
 * folded into the same "Updated Ns ago" sentence a healthy poll renders. */
function FreshnessChip({
  dataUpdatedAt,
  isError,
}: {
  dataUpdatedAt: number;
  isError: boolean;
}) {
  if (isError) {
    return (
      <span
        data-testid="freshness-chip"
        className="flex items-center gap-1 text-xs text-amber"
      >
        <WifiOff aria-hidden className="size-3.5 shrink-0" />
        Disconnected
      </span>
    );
  }
  if (dataUpdatedAt === 0) return null;
  return (
    <span data-testid="freshness-chip" className="text-xs text-muted-foreground">
      Updated {formatRelative(new Date(dataUpdatedAt).toISOString(), new Date())}
    </span>
  );
}

/** Read-only runs history (persist-to-db Phase 1, T11): a master list of
 * `runs` rows on the left, the selected run's funnel + events on the
 * right. No polling — a manual Refresh button is the only way to see new
 * rows, matching the brief's "no polling beyond manual refresh". */
export function RunsPage({ profile }: { profile: string }) {
  const qc = useQueryClient();
  // Kept in RunsPage rather than RunDetailView (decided, docs/product/
  // run-experience-overhaul/mockup.html's diagnosis "Run again" actions)
  // so RunDetailView stays presentational — its own bare-render tests never
  // need a QueryClientProvider or fetch stubbing just to exercise a click.
  const runControl = useRunControl(profile);
  const cachedRows =
    qc.getQueryData<{ rows: RunSummary[] }>(runsKeys.list(profile))?.rows ?? [];
  const pollInterval = cachedRows.some((r) => r.status === 'running')
    ? LIVE_POLL_MS
    : false;
  const runsQuery = useRuns(profile, pollInterval);
  const rows = runsQuery.data?.rows ?? [];
  const runningRow = rows.find((r) => r.status === 'running') ?? null;
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // D3b (blueprint.md step 1.4) — the day-reassurance line's own data,
  // scoped to `today` (local, matching the daemon's own convention). No
  // polling on `deferredQuery`, unlike `runsQuery` — task 22's own design.
  const today = todayLocalDate();
  const deferredQuery = useDeferredSlots(profile, today);
  const deferredRows = deferredQuery.data?.rows ?? [];
  const deferredCount = deferredRows.length;
  // `runCount`/`failedCount` scope to TODAY's rows specifically — `rows`
  // itself (the `/runs` list response) can span more than one day, per
  // this task's own brief. `failedCount` reuses `classifyOutcome`'s
  // 'failed'/'crashed' kinds (the same classification `RunsList` already
  // renders `data-outcome-kind` from) rather than a second, divergent
  // status check.
  const todaysRows = rows.filter((r) => r.date === today);
  const runCount = todaysRows.length;
  const failedCount = todaysRows.filter((r) => {
    const kind = classifyOutcome(r, r.softErrors);
    return kind === 'failed' || kind === 'crashed';
  }).length;
  const dayReassuranceText = `${today} · ${runCount} run${runCount === 1 ? '' : 's'}, ${deferredCount} slots deferred, ${failedCount} failed`;

  // `classifyOutcome` (runOutcome.ts) can only resolve produced/empty/
  // degraded/unrecorded from a RunDetail's `result`/`failure` blobs, which
  // `listRuns()` never returns — a bare `RunSummary` fails safe to
  // 'degraded' (passed) or generic 'crashed' (crashed-but-truly-unrecorded).
  // `running`/`failed` rows classify correctly from `status` alone, so only
  // `passed`/`crashed` rows need hydrating. Reuses `runQuery`'s cache key,
  // so this shares data with the detail pane's own `useRun` fetch for
  // whichever row is selected — no duplicate request for that one.
  const detailQueries = useQueries({
    queries: rows
      .filter((r) => r.status === 'passed' || r.status === 'crashed')
      .map((r) => runQuery(profile, r.id)),
  });
  const detailById = new Map<number, RunDetail>();
  for (const q of detailQueries) {
    if (q.data) detailById.set(q.data.id, q.data);
  }
  // Health-gate inputs (fix-round finding #4) — `rows` (the `/runs` list
  // response) always carries `softErrors` per row, but hydrating a row into
  // its fetched `RunDetail` above would otherwise DROP that field (`useRun`
  // never returns it — the detail pane fetches it separately, only for the
  // selected run). Carry it through explicitly so `RunsList` always has a
  // real `SoftErrorSummary` to classify with, hydrated or not.
  const listRows: ((RunSummary | RunDetail) & { softErrors?: SoftErrorSummary })[] =
    rows.map((r) => {
      const hydrated = detailById.get(r.id);
      return hydrated ? { ...hydrated, softErrors: r.softErrors } : r;
    });

  // Default-select the newest run once the list resolves, mirroring
  // TriagePage's first-row default — never overrides a user's own pick.
  useEffect(() => {
    if (selectedId === null && rows.length > 0) {
      setSelectedId(rows[0]?.id ?? null);
    }
  }, [rows, selectedId]);

  const detailQuery = useRun(profile, selectedId ?? -1);
  const eventsQuery = useRunEvents(profile, selectedId ?? -1);
  const softErrorsQuery = useSoftErrors(profile, selectedId ?? -1);

  const noLocalDb = isNoLocalDb(runsQuery.error);
  const isError = runsQuery.isError && !noLocalDb;
  const detail =
    selectedId !== null && detailQuery.data?.id === selectedId
      ? detailQuery.data
      : undefined;
  const events = eventsQuery.data?.rows ?? [];

  // BUG 3 (pipeline-stability-hardening QA round 2, 2026-08-14) —
  // today's own catch-up row, if any, found by identity (never assumed to
  // be `listRows[0]` positionally) so the deferred group threads in
  // directly after it via `RunsList`'s `insertAfterId` slot. `date` here
  // is each row's OWN scheduled/run date (matching `todaysRows` above),
  // not `startedAt` — mirrors the daemon's own local-date convention.
  const catchupRowToday =
    listRows.find((r) => r.catchupSlots != null && r.date === today) ?? null;

  const deferredRegion = deferredQuery.isPending ? (
    <Skeleton className="h-12" />
  ) : deferredQuery.isError ? (
    <ErrorRetry
      message="Couldn't load deferred slots — the board server may be unreachable."
      onRetry={() => deferredQuery.refetch()}
    />
  ) : (
    deferredRows.length > 0 && <DeferredGroup rows={deferredRows} />
  );

  return (
    <div data-qa="runs-page" className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b p-3">
        <h1 className="text-lg font-semibold font-heading">Runs</h1>
        <div className="flex items-center gap-3">
          <FreshnessChip dataUpdatedAt={runsQuery.dataUpdatedAt} isError={isError} />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => runsQuery.refetch()}
          >
            Refresh
          </Button>
        </div>
      </div>
      {runningRow && (
        <LiveRunHeader
          profile={profile}
          run={runningRow}
          pollError={isError}
          lastUpdatedAt={runsQuery.dataUpdatedAt}
          onRetry={() => runsQuery.refetch()}
          estimatedDurationMs={
            detailQuery.data?.id === runningRow.id
              ? detailQuery.data.estimatedDurationMs
              : null
          }
        />
      )}
      <div className="grid flex-1 grid-cols-[minmax(280px,360px)_1fr] overflow-hidden">
        <section className="overflow-y-auto border-r">
          <p
            data-qa="runs-day-reassurance"
            className="p-3 pb-0 text-xs text-muted-foreground"
          >
            {dayReassuranceText}
          </p>
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
            <>
              {/* Deferred region (mockup.html S1 DOM order: day reassurance
                  -> catch-up row -> deferred group -> older runs; BUG 3
                  round 2 — a prior version placed this ABOVE the whole
                  list unconditionally, which put it above the catch-up row
                  too, inverting ux-notes callout 6's Von Restorff intent
                  (the eye must land on the catch-up row that COVERED the
                  day, not on the deferred footnote). When today's catch-up
                  row is present in `listRows`, this same block is instead
                  threaded into `RunsList` via `insertAfterId`/
                  `insertContent`, so it renders directly after that row —
                  never merged into RunsList's own `rows` prop, which
                  cannot represent a deferred slot without widening a type
                  five other call sites depend on. Loading gets exactly ONE
                  Skeleton (never the list's own 3x block — "or loading
                  itself would look like an alarm"); an error here is
                  scoped to just this region so it never blanks the runs
                  list next to it. Absent a same-day catch-up row, the
                  group renders at the top of the list, directly under the
                  reassurance line — unchanged from before. */}
              {!catchupRowToday && <div className="p-3">{deferredRegion}</div>}
              <RunsList
                rows={listRows}
                selectedId={selectedId}
                onSelect={setSelectedId}
                insertAfterId={catchupRowToday?.id ?? null}
                insertContent={
                  catchupRowToday ? <div className="p-3">{deferredRegion}</div> : null
                }
              />
            </>
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
            <RunDetailView
              run={detail}
              events={events}
              softErrors={softErrorsQuery.data}
              profile={profile}
              onRun={runControl.onRun}
            />
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
