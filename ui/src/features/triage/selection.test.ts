import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardJobRow } from '../../lib/api/types';
import { useTriageSelection } from './selection';

const { recallSelection, rememberSelection, resetMemo } = vi.hoisted(() => {
  let value: string | null = null;
  return {
    recallSelection: () => value,
    rememberSelection: (id: string) => {
      value = id;
    },
    resetMemo: () => {
      value = null;
    },
  };
});

vi.mock('../../lib/selection-memo', () => ({ recallSelection, rememberSelection }));

function row(id: string): BoardJobRow {
  return { id } as unknown as BoardJobRow;
}

beforeEach(() => {
  resetMemo();
});

describe('useTriageSelection', () => {
  it('defaults to the first row when nothing was remembered', () => {
    const rows = [row('a'), row('b'), row('c')];
    const { result } = renderHook(() => useTriageSelection(rows));
    expect(result.current.selectedId).toBe('a');
  });

  it('defaults to the first row when the remembered id is stale (not in rows)', () => {
    rememberSelection('zzz');
    const rows = [row('a'), row('b')];
    const { result } = renderHook(() => useTriageSelection(rows));
    expect(result.current.selectedId).toBe('a');
  });

  it('recalls the remembered id when it is present in rows', () => {
    rememberSelection('b');
    const rows = [row('a'), row('b'), row('c')];
    const { result } = renderHook(() => useTriageSelection(rows));
    expect(result.current.selectedId).toBe('b');
  });

  it('defaults to null when there are no rows', () => {
    const { result } = renderHook(() => useTriageSelection([]));
    expect(result.current.selectedId).toBeNull();
  });

  it('move(+1) advances and move(-1) retreats, clamping at both ends', () => {
    const rows = [row('a'), row('b'), row('c')];
    const { result } = renderHook(() => useTriageSelection(rows));
    expect(result.current.selectedId).toBe('a');

    act(() => result.current.move(-1));
    expect(result.current.selectedId).toBe('a'); // clamped at the start

    act(() => result.current.move(1));
    expect(result.current.selectedId).toBe('b');
    act(() => result.current.move(1));
    expect(result.current.selectedId).toBe('c');
    act(() => result.current.move(1));
    expect(result.current.selectedId).toBe('c'); // clamped at the end
  });

  it('select() picks an arbitrary row by id', () => {
    const rows = [row('a'), row('b'), row('c')];
    const { result } = renderHook(() => useTriageSelection(rows));
    act(() => result.current.select('c'));
    expect(result.current.selectedId).toBe('c');
  });

  it('survives a row refetch (new array reference, same ids) without resetting', () => {
    const rows1 = [row('a'), row('b'), row('c')];
    const { result, rerender } = renderHook(({ rows }) => useTriageSelection(rows), {
      initialProps: { rows: rows1 },
    });
    act(() => result.current.select('b'));
    expect(result.current.selectedId).toBe('b');

    const rows2 = [row('a'), row('b'), row('c')]; // new references, same ids
    rerender({ rows: rows2 });
    expect(result.current.selectedId).toBe('b');
  });

  it('resets to the first row when the selected id drops out of a refetch', () => {
    const rows1 = [row('a'), row('b'), row('c')];
    const { result, rerender } = renderHook(({ rows }) => useTriageSelection(rows), {
      initialProps: { rows: rows1 },
    });
    act(() => result.current.select('b'));
    expect(result.current.selectedId).toBe('b');

    const rows2 = [row('a'), row('c')]; // 'b' filtered out
    rerender({ rows: rows2 });
    expect(result.current.selectedId).toBe('a');
  });
});
