import type { BoardJobRow } from '../../lib/api/types';

/** The kanban's "Closed" pool — terminal statuses never get their own
 * column (spec decision, CLAUDE.md task brief).
 * Mirror of src/core/tracking/vocab.ts terminal statuses — update both together
 * (ui imports backend types only via lib/api/types.ts, so this is a deliberate
 * value-level mirror). */
export const TERMINAL_STATUSES = ['Rejected', 'Passed'] as const;

export interface KanbanColumnGroup {
  status: string;
  rows: BoardJobRow[];
}

export interface GroupedRows {
  columns: KanbanColumnGroup[];
  closed: BoardJobRow[];
}

/**
 * Groups tracked rows into one column per non-terminal vocab status (in
 * vocab order, even when a column ends up empty) plus a `closed` pool for
 * the two terminal statuses. Rows with `tracking?.status == null` are
 * excluded — undecided jobs are triage's domain, not the tracker's.
 */
export function groupByStatus(rows: BoardJobRow[], statusOptions: string[]): GroupedRows {
  const terminal = new Set<string>(TERMINAL_STATUSES);
  const columns: KanbanColumnGroup[] = statusOptions
    .filter((status) => !terminal.has(status))
    .map((status) => ({
      status,
      rows: rows.filter((row) => row.tracking?.status === status),
    }));
  const closed = rows.filter((row) => {
    const status = row.tracking?.status;
    return status != null && terminal.has(status);
  });
  return { columns, closed };
}

/**
 * Rows whose `nextActionDate` is today or in the past (ISO date string
 * compare — both sides are `YYYY-MM-DD`), sorted ascending so the most
 * overdue lands first. Rows with no `nextActionDate` are ignored.
 */
export function dueRows(rows: BoardJobRow[], today: string): BoardJobRow[] {
  return rows
    .filter((row) => {
      const date = row.tracking?.nextActionDate;
      return date != null && date <= today;
    })
    .sort((a, b) => {
      const da = a.tracking?.nextActionDate ?? '';
      const db = b.tracking?.nextActionDate ?? '';
      return da < db ? -1 : da > db ? 1 : 0;
    });
}
