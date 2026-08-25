import { CheckCircle2 } from 'lucide-react';
import type { BoardJobRow } from '../../lib/api/types';
import { navigate } from '../../lib/router';
import { JobRow } from './JobRow';

export function JobList({
  rows,
  selectedId,
  onSelect,
  filtered,
  onClearFilters,
}: {
  rows: BoardJobRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** True when a company/status/excitement filter is active — distinguishes
   * "this filter has no matches" from "the board is actually empty" so the
   * empty state never claims a specific job count it doesn't have. */
  filtered: boolean;
  onClearFilters: () => void;
}) {
  if (rows.length === 0) {
    return (
      <div
        className="flex flex-col items-center gap-2 p-6 text-center"
        data-qa="list-empty"
      >
        <CheckCircle2 className="size-7 text-muted-foreground" />
        {filtered ? (
          <>
            <p className="text-sm font-medium">No jobs match these filters.</p>
            <button
              type="button"
              className="text-xs"
              data-qa="clear-filters"
              onClick={onClearFilters}
            >
              Clear filters
            </button>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">Nothing left to decide.</p>
            <p className="text-xs text-muted-foreground">
              You&apos;ve decided on everything on the board.
            </p>
            <button
              type="button"
              className="text-xs"
              onClick={() => navigate({ name: 'tracker' })}
            >
              View the tracker →
            </button>
          </>
        )}
      </div>
    );
  }
  return (
    <div role="listbox" aria-label="Jobs">
      {rows.map((row) => (
        <JobRow
          key={row.id}
          row={row}
          selected={row.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
