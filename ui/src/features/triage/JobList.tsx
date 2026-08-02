import type { BoardJobRow } from '../../lib/api/types';
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
    return <div className="p-4 text-sm text-muted-foreground">No jobs match.</div>;
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
