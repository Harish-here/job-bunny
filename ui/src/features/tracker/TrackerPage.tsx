import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { ListQuery, TrackingPatchBody } from '../../lib/api/types';
import { useJobs, useMeta } from '../board/useBoardData';
import { useTrackingMutation } from '../board/useTracking';
import { DueStrip } from './DueStrip';
import { dueRows, groupByStatus } from './grouping';
import { KanbanCard } from './KanbanCard';
import { KanbanColumn } from './KanbanColumn';

// KNOWN LIMIT: a single page of up to 200 active jobs (newest-found first)
// feeds the whole kanban — a profile with more than 200 non-archived jobs
// truncates silently. Acceptable at current volumes (spec decision).
const QUERY: ListQuery = {
  archived: 'false',
  limit: 200,
  offset: 0,
  sort: 'date_found',
  order: 'desc',
};

const HIGHLIGHT_MS = 1500;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function TrackerPage({ profile }: { profile: string }) {
  const metaQuery = useMeta(profile);
  const jobsQuery = useJobs(profile, QUERY);
  const mutation = useTrackingMutation(profile);

  const rows = useMemo(() => jobsQuery.data?.rows ?? [], [jobsQuery.data]);
  const statusOptions = metaQuery.data?.statusOptions ?? [];
  const { columns, closed } = useMemo(
    () => groupByStatus(rows, statusOptions),
    [rows, statusOptions],
  );
  const due = useMemo(() => dueRows(rows, todayIso()), [rows]);

  const [closedOpen, setClosedOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  function registerCardRef(jobId: string, el: HTMLElement | null): void {
    if (el) cardRefs.current.set(jobId, el);
    else cardRefs.current.delete(jobId);
  }

  // `statusOptions` comes back from `/meta` as plain `string[]`, but
  // `TrackingPatchBody.status` is the narrower vocab literal union — same
  // cast `fieldPatch` (T4/T8) uses to bridge that gap.
  function handleStatusChange(jobId: string, status: string): void {
    const row = rows.find((r) => r.id === jobId);
    if (!row || row.tracking?.status === status) return; // no-op guard
    mutation.mutate({ jobId, patch: { status } as TrackingPatchBody });
  }

  function handleDragEnd(event: DragEndEvent): void {
    if (!event.over) return;
    handleStatusChange(String(event.active.id), String(event.over.id));
  }

  function focusCard(jobId: string): void {
    cardRefs.current.get(jobId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedId(jobId);
    setTimeout(() => {
      setHighlightedId((current) => (current === jobId ? null : current));
    }, HIGHLIGHT_MS);
  }

  return (
    <div className="flex h-screen flex-col">
      <DueStrip rows={due} onFocusCard={focusCard} />
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex flex-1 gap-3 overflow-x-auto p-4">
          {columns.map((col) => (
            <KanbanColumn
              key={col.status}
              status={col.status}
              rows={col.rows}
              statusOptions={statusOptions}
              highlightedId={highlightedId}
              registerCardRef={registerCardRef}
              onStatusChange={handleStatusChange}
            />
          ))}

          <div
            data-testid="closed-column"
            className="flex w-64 shrink-0 flex-col rounded-lg border bg-muted/20"
          >
            <button
              type="button"
              className="flex items-center gap-1 border-b px-2 py-1.5 text-sm font-medium"
              onClick={() => setClosedOpen((open) => !open)}
            >
              {closedOpen ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              Closed ({closed.length})
            </button>
            {closedOpen && (
              <div className="flex flex-col gap-2 overflow-y-auto p-2">
                {closed.map((row) => (
                  <KanbanCard
                    key={row.id}
                    row={row}
                    statusOptions={statusOptions}
                    highlighted={highlightedId === row.id}
                    registerRef={registerCardRef}
                    onStatusChange={handleStatusChange}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </DndContext>
    </div>
  );
}
