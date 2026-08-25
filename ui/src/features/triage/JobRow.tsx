import type { BoardJobRow } from '../../lib/api/types';
import { cn } from '../../lib/utils';
import { laneLabel } from '../../lib/vocabulary';
import { StatusPip } from './StatusPip';

/** Row-level score weight band (ux-notes.md §6, verbatim — DIFFERENT
 * thresholds than `scoreBand()`/`scoreSegments()` in `core/job/score.ts`,
 * used only inside `MatchScore` in the detail pane; the two must not be
 * conflated). `null` -> no weight class (base `text-sm` only, per the S1
 * mockup's "Infrastructure Engineer" row). */
function scoreWeightClass(score: number | null): string {
  if (score == null) return '';
  if (score >= 75) return 'font-semibold text-foreground';
  if (score >= 50) return 'font-medium text-foreground';
  return 'font-normal text-muted-foreground';
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
      data-qa="job-row"
      data-job-id={row.id}
      onClick={() => onSelect(row.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(row.id);
        }
      }}
      className={cn(
        'flex cursor-pointer flex-col gap-0.5 border-b px-3 py-2 hop',
        selected
          ? 'border-l-2 border-l-primary bg-accent text-accent-foreground'
          : 'hover:bg-muted/50',
      )}
    >
      <div className="flex items-center gap-2">
        <StatusPip
          status={row.tracking?.status ?? null}
          data-testid="job-row-status"
          title={row.tracking?.status ?? 'Undecided'}
        />
        <span className={cn('flex-1 truncate text-sm', scoreWeightClass(row.score))}>
          {row.title}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {row.score != null ? `${row.score} /100` : '—'}
        </span>
      </div>
      <div className="truncate pl-3.5 text-xs text-muted-foreground">
        {row.company}
        {line && ` · ${line}`}
        {' · '}
        {laneLabel(row.lane)}
      </div>
    </div>
  );
}
