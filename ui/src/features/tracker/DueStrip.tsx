import { Badge } from '../../components/ui/badge';
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
          <Badge
            variant="outline"
            className="border-attention/40 bg-attention/10 text-attention"
          >
            ⚡ {row.company} — {row.tracking?.nextAction} ({row.tracking?.nextActionDate})
          </Badge>
        </button>
      ))}
    </div>
  );
}
