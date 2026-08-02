import { useEffect, useState } from 'react';
import type { BoardJobRow } from '../../lib/api/types';
import { recallSelection, rememberSelection } from '../../lib/selection-memo';

/**
 * Triage's list selection: defaults to the first row, reconciles against a
 * refetched `rows` array (survives when the id is still present, resets to
 * the first row when it drops out), and shares the last pick across views
 * via `lib/selection-memo` (T3) rather than owning that state itself.
 */
export function useTriageSelection(rows: BoardJobRow[]): {
  selectedId: string | null;
  select: (id: string) => void;
  move: (delta: 1 | -1) => void;
} {
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const recalled = recallSelection();
    return recalled !== null && rows.some((row) => row.id === recalled) ? recalled : null;
  });

  useEffect(() => {
    if (selectedId !== null && rows.some((row) => row.id === selectedId)) return;
    setSelectedId(rows[0]?.id ?? null);
  }, [rows, selectedId]);

  function select(id: string): void {
    setSelectedId(id);
    rememberSelection(id);
  }

  function move(delta: 1 | -1): void {
    if (rows.length === 0) return;
    const index = rows.findIndex((row) => row.id === selectedId);
    const from = index === -1 ? 0 : index;
    const next = Math.min(Math.max(from + delta, 0), rows.length - 1);
    const id = rows[next]?.id;
    if (id !== undefined) select(id);
  }

  return { selectedId, select, move };
}
