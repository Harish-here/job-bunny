import { describe, expect, it } from 'vitest';
import type { BoardJobRow } from '../../lib/api/types';
import { DECIDE_STATUS, nextUndecided } from './decide';

/** `status: null` (the default) means undecided; pass a status string for a
 * decided row. */
function row(id: string, status: string | null = null): BoardJobRow {
  return {
    id,
    tracking: status === null ? null : { jobId: id, updatedAt: 't0', status },
  } as unknown as BoardJobRow;
}

describe('DECIDE_STATUS', () => {
  it('byte-matches the tracking vocab', () => {
    expect(DECIDE_STATUS).toEqual({
      apply: 'Applied',
      skip: 'Passed',
      save: 'Lead',
    });
  });
});

describe('nextUndecided', () => {
  it('returns the next undecided row after the current one', () => {
    const rows = [
      row('a', 'Applied'),
      row('b', 'Applied'),
      row('c'), // undecided
      row('d', 'Applied'),
    ];
    expect(nextUndecided(rows, 'a')).toBe('c');
  });

  it('wraps around to earlier rows when none remain after the current one', () => {
    const rows = [
      row('a'), // undecided
      row('b', 'Applied'),
      row('c', 'Applied'),
      row('d', 'Applied'),
    ];
    expect(nextUndecided(rows, 'c')).toBe('a');
  });

  it('returns null when no row is undecided', () => {
    const rows = [row('a', 'Applied'), row('b', 'Applied'), row('c', 'Applied')];
    expect(nextUndecided(rows, 'a')).toBeNull();
  });

  it('excludes fromId itself even if it still reads as undecided', () => {
    const rows = [row('a'), row('b', 'Applied'), row('c', 'Applied')];
    expect(nextUndecided(rows, 'a')).toBeNull();
  });

  it('returns null for an empty row list', () => {
    expect(nextUndecided([], 'a')).toBeNull();
  });

  it('treats a null fromId as starting before the first row', () => {
    const rows = [row('a'), row('b', 'Applied')];
    expect(nextUndecided(rows, null)).toBe('a');
  });
});
