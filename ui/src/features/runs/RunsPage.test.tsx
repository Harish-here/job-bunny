import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunDetail, RunEventRow, RunSummary } from '../../lib/api/types';
import { RunsPage } from './RunsPage';

const ROWS: RunSummary[] = [
  {
    id: 2,
    date: '2026-08-05',
    timeDir: '09-00',
    kind: 'run',
    resumedFrom: null,
    status: 'passed',
    startedAt: '2026-08-05T09:00:00.000Z',
    finishedAt: '2026-08-05T09:05:00.000Z',
    heartbeatAt: '2026-08-05T09:05:00.000Z',
  },
  {
    id: 1,
    date: '2026-08-04',
    timeDir: '09-00',
    kind: 'stage',
    resumedFrom: null,
    status: 'failed',
    startedAt: '2026-08-04T09:00:00.000Z',
    finishedAt: '2026-08-04T09:01:00.000Z',
    heartbeatAt: '2026-08-04T09:01:00.000Z',
  },
];

function detailFor(row: RunSummary): RunDetail {
  return {
    ...row,
    result: {
      stages: [{ name: 'filter', jobsIn: 10, jobsOut: 7, dropsByRule: { title: 3 } }],
    },
    failure: row.status === 'failed' ? { stage: 'structure', error: 'boom' } : null,
    syncDryrun: null,
  };
}

const EVENTS: RunEventRow[] = [
  { ts: '2026-08-05T09:00:01.000Z', level: 'info', msg: 'stage started' },
  { ts: '2026-08-05T09:00:02.000Z', level: 'warn', msg: 'slow request' },
];

function stubFetch(
  opts: { noLocalDb?: boolean; serverError?: boolean; rows?: RunSummary[] } = {},
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const eventsMatch = url.match(/\/runs\/(\d+)\/events/);
      if (eventsMatch) {
        return {
          ok: true,
          json: async () => ({ rows: EVENTS, total: 2 }),
        } as unknown as Response;
      }
      const detailMatch = url.match(/\/runs\/(\d+)$/);
      if (detailMatch?.[1]) {
        const rows = opts.rows ?? ROWS;
        const row = rows.find((r) => r.id === Number(detailMatch[1])) ?? rows[0];
        if (!row) throw new Error('no fixture row');
        return { ok: true, json: async () => detailFor(row) } as unknown as Response;
      }
      if (url.includes('/runs')) {
        if (opts.noLocalDb) {
          return {
            ok: false,
            status: 404,
            json: async () => ({
              error: { code: 'no_local_db', message: 'no local db' },
            }),
          } as unknown as Response;
        }
        if (opts.serverError) {
          return {
            ok: false,
            status: 500,
            json: async () => ({
              error: { code: 'internal', message: 'internal error' },
            }),
          } as unknown as Response;
        }
        const rows = opts.rows ?? ROWS;
        return {
          ok: true,
          json: async () => ({ rows, total: rows.length, limit: 100, offset: 0 }),
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
      <RunsPage profile="rajni" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RunsPage', () => {
  it('renders rows, selects the newest by default, and shows its funnel + events', async () => {
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId('run-row')).toHaveLength(2);
    });
    expect(screen.getAllByTestId('run-row')[0]).toHaveAttribute('aria-selected', 'true');

    await waitFor(() => {
      expect(screen.getByText('filter')).toBeInTheDocument();
    });
    expect(screen.getByText('10 → 7')).toBeInTheDocument();
    expect(screen.getByText('title: 3')).toBeInTheDocument();
    expect(screen.getByText('stage started')).toBeInTheDocument();
  });

  it('clicking a row selects it and shows its failed-stage banner', async () => {
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId('run-row')).toHaveLength(2);
    });
    await userEvent.click(screen.getAllByTestId('run-row')[1] as HTMLElement);

    await waitFor(() => {
      expect(screen.getByText(/Failed at stage: structure/)).toBeInTheDocument();
    });
  });

  it('shows the empty state for a profile with no runs', async () => {
    stubFetch({ rows: [] });
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('runs-empty')).toBeInTheDocument();
    });
    expect(screen.getByText(/no runs recorded yet/i)).toBeInTheDocument();
    expect(screen.getByText('No run selected.')).toBeInTheDocument();
  });

  it('shows a friendly empty state for a profile with no local database', async () => {
    stubFetch({ noLocalDb: true });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/no local database/i)).toBeInTheDocument();
    });
  });

  it('shows a distinct error state on a server failure', async () => {
    stubFetch({ serverError: true });
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText(/couldn't load runs/i).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByRole('button', { name: /retry/i }).length).toBeGreaterThan(0);
  });

  it('renders the live run header for an in-flight run', async () => {
    const runningRows: RunSummary[] = [
      {
        id: 3,
        date: '2026-08-06',
        timeDir: '09-00',
        kind: 'run',
        resumedFrom: null,
        status: 'running',
        startedAt: '2026-08-06T09:00:00.000Z',
        finishedAt: null,
        heartbeatAt: '2026-08-06T09:00:05.000Z',
      },
      ...ROWS,
    ];
    stubFetch({ rows: runningRows });
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('live-run-header')).toBeInTheDocument();
    });
    expect(screen.getByTestId('live-run-stage')).toHaveTextContent('Running — starting…');
  });

  it('renders no live run header when every run has finished', async () => {
    stubFetch();
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId('run-row')).toHaveLength(2);
    });
    expect(screen.queryByTestId('live-run-header')).not.toBeInTheDocument();
  });
});
