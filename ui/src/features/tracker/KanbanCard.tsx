import { useDraggable } from '@dnd-kit/core';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import type { BoardJobRow } from '../../lib/api/types';
import { navigate } from '../../lib/router';
import { cn } from '../../lib/utils';

function isOverdue(nextActionDate: string | null | undefined, today: string): boolean {
  return nextActionDate != null && nextActionDate < today;
}

/**
 * One draggable job card. Drag-to-column is the primary status-change
 * path (`useDraggable`, paired with `KanbanColumn`'s `useDroppable`); the
 * status `Select` is the click-only fallback. A plain click (no drag
 * distance — see `TrackerPage`'s `PointerSensor` activation constraint)
 * navigates to the full job page.
 */
export function KanbanCard({
  row,
  statusOptions,
  highlighted,
  registerRef,
  onStatusChange,
}: {
  row: BoardJobRow;
  statusOptions: string[];
  highlighted: boolean;
  registerRef: (jobId: string, el: HTMLElement | null) => void;
  onStatusChange: (jobId: string, status: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: row.id });

  // A fresh callback identity every render is fine here — React invokes it
  // with the element on mount/update and with `null` on unmount either way,
  // so the ref registry (DueStrip's scroll-into-view target) self-heals
  // without needing a separate cleanup effect.
  function setRefs(el: HTMLDivElement | null): void {
    setNodeRef(el);
    registerRef(row.id, el);
  }

  const today = new Date().toISOString().slice(0, 10);
  const overdue = isOverdue(row.tracking?.nextActionDate, today);
  const dateLabel = row.tracking?.dateApplied ?? row.dateFound.slice(0, 10);

  return (
    // biome-ignore lint/a11y/useSemanticElements: must stay a div — it's dnd-kit's drag handle and wraps the status Select, a nested interactive control that can't live inside a real <button>.
    <div
      ref={setRefs}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={() => navigate({ name: 'job', id: row.id })}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigate({ name: 'job', id: row.id });
        }
      }}
      className={cn(
        'flex cursor-pointer flex-col gap-1 rounded-lg border bg-card p-2 text-sm shadow-sm',
        isDragging && 'opacity-50',
        highlighted && 'ring-2 ring-primary transition-shadow',
      )}
    >
      <div className="truncate font-medium">{row.company}</div>
      <div className="truncate text-xs text-muted-foreground">{row.title}</div>
      <div className="text-xs text-muted-foreground">{dateLabel}</div>
      {row.tracking?.nextAction && (
        <div
          className={cn(
            'truncate text-xs',
            overdue ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {row.tracking.nextAction}
          {row.tracking.nextActionDate && ` (${row.tracking.nextActionDate})`}
        </div>
      )}
      <Select
        value={row.tracking?.status ?? ''}
        onValueChange={(status) => onStatusChange(row.id, status)}
      >
        <SelectTrigger
          className="h-6 w-full text-xs"
          aria-label={`Status for ${row.title}`}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {statusOptions.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
