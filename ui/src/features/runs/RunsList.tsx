import { Badge } from '../../components/ui/badge';
import type { RunSummary } from '../../lib/api/types';
import { cn } from '../../lib/utils';
import { formatDuration, formatWhen, statusLabel, statusVariant } from './runFormat';

export function RunsList({
  rows,
  selectedId,
  onSelect,
}: {
  rows: RunSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  if (rows.length === 0) {
    return (
      <div data-testid="runs-empty" className="p-4 text-sm text-muted-foreground">
        No runs recorded yet — this profile hasn't completed a pipeline run.
      </div>
    );
  }

  return (
    <div role="listbox" aria-label="Runs">
      {rows.map((row) => {
        const selected = row.id === selectedId;
        return (
          <div
            key={row.id}
            role="option"
            tabIndex={0}
            aria-selected={selected}
            data-testid="run-row"
            data-run-id={row.id}
            onClick={() => onSelect(row.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(row.id);
              }
            }}
            className={cn(
              'flex cursor-pointer flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2 hop',
              selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{formatWhen(row)}</span>
              <Badge
                variant={statusVariant(row.status)}
                className={
                  row.status === 'passed'
                    ? 'text-success'
                    : row.status === 'running'
                      ? 'text-primary'
                      : undefined
                }
              >
                {statusLabel(row.status)}
              </Badge>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="capitalize">{row.kind}</span>
              <span>·</span>
              <span>{formatDuration(row.startedAt, row.finishedAt)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
