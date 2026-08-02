import { describe, expect, it } from 'vitest';
import type { BoardJobRow } from '../../lib/api/types';
import { dueRows, groupByStatus, TERMINAL_STATUSES } from './grouping';

const STATUS_OPTIONS = [
  'Lead',
  'Applied',
  'Recruiter Screen',
  'Tech Round',
  'Onsite',
  'Offer',
  'Rejected',
  'Passed',
];

function row(
  id: string,
  status: string | null = null,
  extra: { nextActionDate?: string } = {},
): BoardJobRow {
  return {
    id,
    company: `Co-${id}`,
    title: `Title-${id}`,
    dateFound: '2026-08-01T00:00:00.000Z',
    tracking: status === null ? null : { jobId: id, updatedAt: 't0', status, ...extra },
  } as unknown as BoardJobRow;
}

describe('TERMINAL_STATUSES', () => {
  it('is Rejected and Passed', () => {
    expect(TERMINAL_STATUSES).toEqual(['Rejected', 'Passed']);
  });
});

describe('groupByStatus', () => {
  it('orders columns per the vocab order, excluding terminals', () => {
    const { columns } = groupByStatus([], STATUS_OPTIONS);
    expect(columns.map((c) => c.status)).toEqual([
      'Lead',
      'Applied',
      'Recruiter Screen',
      'Tech Round',
      'Onsite',
      'Offer',
    ]);
  });

  it('excludes undecided rows (tracking?.status == null)', () => {
    const rows = [row('a', null), row('b', 'Lead')];
    const { columns, closed } = groupByStatus(rows, STATUS_OPTIONS);
    const allGrouped = columns.flatMap((c) => c.rows).concat(closed);
    expect(allGrouped.map((r) => r.id)).toEqual(['b']);
  });

  it('pools terminal-status rows into `closed`, not a column', () => {
    const rows = [row('a', 'Rejected'), row('b', 'Passed'), row('c', 'Lead')];
    const { columns, closed } = groupByStatus(rows, STATUS_OPTIONS);
    expect(closed.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(columns.flatMap((c) => c.rows).map((r) => r.id)).toEqual(['c']);
  });

  it('produces no columns for empty statusOptions', () => {
    const { columns } = groupByStatus([row('a', 'Lead')], []);
    expect(columns).toEqual([]);
  });

  it('puts each row only in its own status column', () => {
    const rows = [row('a', 'Lead'), row('b', 'Offer'), row('c', 'Lead')];
    const { columns } = groupByStatus(rows, STATUS_OPTIONS);
    const lead = columns.find((c) => c.status === 'Lead');
    const offer = columns.find((c) => c.status === 'Offer');
    expect(lead?.rows.map((r) => r.id)).toEqual(['a', 'c']);
    expect(offer?.rows.map((r) => r.id)).toEqual(['b']);
  });
});

describe('dueRows', () => {
  const today = '2026-08-02';

  it('includes rows due today and overdue rows, sorted ascending', () => {
    const rows = [
      row('a', 'Applied', { nextActionDate: '2026-08-02' }), // today
      row('b', 'Applied', { nextActionDate: '2026-07-30' }), // overdue
      row('c', 'Applied', { nextActionDate: '2026-08-05' }), // future — excluded
    ];
    expect(dueRows(rows, today).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('ignores rows without a nextActionDate', () => {
    const rows = [row('a', 'Applied'), row('b', 'Applied', { nextActionDate: today })];
    expect(dueRows(rows, today).map((r) => r.id)).toEqual(['b']);
  });

  it('returns an empty array when nothing is due', () => {
    const rows = [row('a', 'Applied', { nextActionDate: '2026-08-10' })];
    expect(dueRows(rows, today)).toEqual([]);
  });
});
