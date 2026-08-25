import { CheckCircle2 } from 'lucide-react';
import type { BoardJobRow } from '../../lib/api/types';
import { navigate } from '../../lib/router';
import { JobRow } from './JobRow';

export function JobList({
  rows,
  selectedId,
  onSelect,
}: {
  rows: BoardJobRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <div
        className="flex flex-col items-center gap-2 p-6 text-center"
        data-qa="list-empty"
      >
        <CheckCircle2 className="size-7 text-muted-foreground" />
        <p className="text-sm font-medium">Nothing left to decide.</p>
        <p className="text-xs text-muted-foreground">
          Your last run added 11 jobs; you&apos;ve decided on all of them.
        </p>
        <button
          type="button"
          className="text-xs"
          onClick={() => navigate({ name: 'tracker' })}
        >
          View the tracker →
        </button>
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
