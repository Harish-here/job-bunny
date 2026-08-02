import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardDetailResponse, BoardJobRow } from '../../lib/api/types';
import { TriagePage } from './TriagePage';

const ROWS: BoardJobRow[] = [
  {
    id: 'li-1',
    lane: 'linkedin',
    title: 'Senior Engineer',
    company: 'Acme',
    url: 'https://acme.example/jobs/1',
    seniority: 'Senior',
    locationCity: 'Remote',
    workType: 'remote',
    timezone: 'IST',
    skills: ['typescript', 'react'],
    excitement: 'Vera level',
    score: 88,
    matchReasons: ['skills overlap'],
    reviewFlags: [],
    dateFound: '2026-08-01T00:00:00.000Z',
    archived: false,
    tracking: null,
  },
  {
    id: 'li-2',
    lane: 'linkedin',
    title: 'Product Manager',
    company: 'Beta',
    url: 'https://beta.example/jobs/2',
    seniority: null,
    locationCity: 'Bengaluru',
    workType: 'hybrid',
    timezone: null,
    skills: [],
    excitement: null,
    score: 60,
    matchReasons: [],
    reviewFlags: [],
    dateFound: '2026-07-30T00:00:00.000Z',
    archived: false,
    tracking: { jobId: 'li-2', updatedAt: 't0', status: 'Applied' },
  },
];

function detailFor(row: BoardJobRow): BoardDetailResponse {
  return {
    ...row,
    jd: {
      identity: {
        id: row.id,
        lane: row.lane,
        url: row.url,
        company: row.company,
        title: row.title,
        scrapedAt: row.dateFound,
      },
      content: { rawText: `${row.title} JD text body.` },
    },
  } as unknown as BoardDetailResponse;
}

function stubFetch(opts: { noLocalDb?: boolean; serverError?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/meta')) {
        return {
          ok: true,
          json: async () => ({
            statusOptions: ['Lead', 'Applied'],
            excitementOptions: ['Vera level'],
          }),
        } as unknown as Response;
      }
      const detailMatch = url.match(/\/jobs\/([^/?]+)$/);
      if (detailMatch?.[1]) {
        const row = ROWS.find((r) => r.id === detailMatch[1]) ?? (ROWS[0] as BoardJobRow);
        return {
          ok: true,
          json: async () => detailFor(row),
        } as unknown as Response;
      }
      if (url.includes('/jobs')) {
        if (opts.noLocalDb) {
          return {
            ok: false,
            status: 404,
            json: async () => ({
              error: { code: 'no_local_db', message: 'no local database' },
            }),
          } as unknown as Response;
        }
        if (opts.serverError) {
          return {
            ok: false,
            status: 500,
            json: async () => ({
              error: { code: 'internal', message: 'internal server error' },
            }),
          } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({ rows: ROWS, total: ROWS.length, limit: 50, offset: 0 }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as unknown as typeof fetch,
  );
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TriagePage profile="rajni" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TriagePage', () => {
  it('renders rows, selects the first by default, and shows its detail', async () => {
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument();
    });
    expect(screen.getByText('Product Manager')).toBeInTheDocument();

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Senior Engineer' }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText('Senior Engineer JD text body.')).toBeInTheDocument();
  });

  it('clicking a row selects it and updates the detail pane', async () => {
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Product Manager')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByText('Product Manager'));

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Product Manager' }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText('Product Manager JD text body.')).toBeInTheDocument();
  });

  it('shows a friendly empty state for a profile with no local database', async () => {
    stubFetch({ noLocalDb: true });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/no local database/i)).toBeInTheDocument();
    });
  });

  it('shows a distinct error state (not "No jobs match") on a server failure', async () => {
    stubFetch({ serverError: true });
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText(/couldn't load jobs/i).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/no jobs match/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /retry/i }).length).toBeGreaterThan(0);
  });
});
