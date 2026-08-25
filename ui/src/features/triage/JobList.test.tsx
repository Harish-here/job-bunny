import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardJobRow } from '../../lib/api/types';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('../../lib/router', () => ({ navigate }));

import { JobList } from './JobList';

afterEach(() => {
  vi.clearAllMocks();
});

/** Fix-round regression: the empty state must never assert a fabricated job
 * count (was a verbatim lift of the mockup's sample "11 jobs" string), and
 * must distinguish "filters have no matches" from "the board is actually
 * empty" — both read from `rows.length === 0`. */
describe('JobList — empty states', () => {
  it('unfiltered: "decided on everything", no invented job count, links to the tracker', async () => {
    render(
      <JobList
        rows={[]}
        selectedId={null}
        onSelect={vi.fn()}
        filtered={false}
        onClearFilters={vi.fn()}
      />,
    );

    expect(screen.getByText('Nothing left to decide.')).toBeInTheDocument();
    expect(
      screen.getByText("You've decided on everything on the board."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\b11\b/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('View the tracker →'));
    expect(navigate).toHaveBeenCalledWith({ name: 'tracker' });
  });

  it('filtered-to-zero: "no jobs match", offers a clear-filters action instead of the tracker link', async () => {
    const onClearFilters = vi.fn();
    render(
      <JobList
        rows={[]}
        selectedId={null}
        onSelect={vi.fn()}
        filtered={true}
        onClearFilters={onClearFilters}
      />,
    );

    expect(screen.getByText('No jobs match these filters.')).toBeInTheDocument();
    expect(screen.queryByText('View the tracker →')).not.toBeInTheDocument();
    expect(screen.queryByText(/decided on everything/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('non-empty rows: renders the listbox, not the empty state', () => {
    const rows: BoardJobRow[] = [
      {
        id: 'a',
        lane: 'linkedin',
        title: 'Engineer',
        company: 'Acme',
        url: 'https://acme.example/jobs/a',
        seniority: null,
        locationCity: null,
        workType: null,
        timezone: null,
        skills: [],
        excitement: null,
        score: 50,
        matchReasons: [],
        reviewFlags: [],
        dateFound: '2026-08-01T00:00:00.000Z',
        archived: false,
        tracking: null,
      },
    ];

    render(
      <JobList
        rows={rows}
        selectedId={null}
        onSelect={vi.fn()}
        filtered={false}
        onClearFilters={vi.fn()}
      />,
    );

    expect(screen.getByRole('listbox', { name: 'Jobs' })).toBeInTheDocument();
    expect(screen.queryByText('Nothing left to decide.')).not.toBeInTheDocument();
  });
});
