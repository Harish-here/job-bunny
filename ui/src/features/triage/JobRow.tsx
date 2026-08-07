import { Badge } from '../../components/ui/badge';
import type { BoardJobRow } from '../../lib/api/types';
import { cn } from '../../lib/utils';

function dotClass(status: string | null | undefined): string {
  if (status == null) return 'bg-muted-foreground/40';
  if (status === 'Rejected' || status === 'Passed') return 'bg-destructive';
  if (status === 'Offer') return 'bg-success';
  return 'bg-primary';
}

export function JobRow({
  row,
  selected,
  onSelect,
}: {
  row: BoardJobRow;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const line = [row.locationCity, row.workType].filter(Boolean).join(' — ');
  return (
    <div
      role="option"
      tabIndex={0}
      aria-selected={selected}
      data-testid="job-row"
      data-job-id={row.id}
      onClick={() => onSelect(row.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(row.id);
        }
      }}
      className={cn(
        'flex cursor-pointer flex-col gap-0.5 border-b px-3 py-1.5 hop',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          data-testid="job-row-status"
          title={row.tracking?.status ?? 'Undecided'}
          className={cn('size-1.5 shrink-0 rounded-full', dotClass(row.tracking?.status))}
        />
        <span className="flex-1 truncate text-sm font-medium">{row.title}</span>
        {row.score != null && (
          <Badge variant="secondary" className="shrink-0">
            {row.score}
          </Badge>
        )}
      </div>
      <div className="truncate pl-3.5 text-xs text-muted-foreground">
        {row.company}
        {line && ` · ${line}`}
      </div>
    </div>
  );
}
