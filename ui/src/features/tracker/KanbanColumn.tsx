import { useDroppable } from '@dnd-kit/core';
import type { BoardJobRow } from '../../lib/api/types';
import { cn } from '../../lib/utils';
import { KanbanCard } from './KanbanCard';

export function KanbanColumn({
  status,
  rows,
  statusOptions,
  highlightedId,
  registerCardRef,
  onStatusChange,
}: {
  status: string;
  rows: BoardJobRow[];
  statusOptions: string[];
  highlightedId: string | null;
  registerCardRef: (jobId: string, el: HTMLElement | null) => void;
  onStatusChange: (jobId: string, status: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div
      ref={setNodeRef}
      data-testid="kanban-column"
      data-status={status}
      className={cn(
        'flex w-64 shrink-0 flex-col rounded-lg border bg-muted/20',
        isOver && 'ring-2 ring-primary',
      )}
    >
      <div className="border-b px-2 py-1.5 text-sm font-medium">
        {status} <span className="text-muted-foreground">({rows.length})</span>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
        {rows.map((row) => (
          <KanbanCard
            key={row.id}
            row={row}
            statusOptions={statusOptions}
            highlighted={highlightedId === row.id}
            registerRef={registerCardRef}
            onStatusChange={onStatusChange}
          />
        ))}
      </div>
    </div>
  );
}
