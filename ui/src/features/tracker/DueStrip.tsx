import type { BoardJobRow } from '../../lib/api/types';

/**
 * Horizontal strip of due/overdue nudges (spec: "focuses/opens its card").
 * Clicking a badge scrolls the matching `KanbanCard` into view and applies
 * a brief focus ring — it never navigates away from the tracker. Hidden
 * entirely when there's nothing due (`rows` empty).
 */
export function DueStrip({
  rows,
  onFocusCard,
}: {
  rows: BoardJobRow[];
  onFocusCard: (jobId: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div data-testid="due-strip" className="flex gap-2 overflow-x-auto border-b p-2">
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className="shrink-0 hop"
          onClick={() => onFocusCard(row.id)}
        >
          <span className="inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl bg-attention px-2 py-0.5 text-xs font-medium whitespace-nowrap text-attention-foreground">
            ⚡ {row.company} — {row.tracking?.nextAction} ({row.tracking?.nextActionDate})
          </span>
        </button>
      ))}
    </div>
  );
}
