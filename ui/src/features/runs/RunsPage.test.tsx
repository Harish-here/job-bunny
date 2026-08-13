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
    progress: null,
    catchupSlots: null,
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
    progress: null,
    catchupSlots: null,
  },
];

function detailFor(row: RunSummary): RunDetail {
  return {
    ...row,
    result: {
      stages: [
        {
          name: 'filter',
          jobsIn: 10,
          jobsOut: 7,
          dropsByRule: { title: 3 },
          elapsedMs: 100,
          attempts: 1,
        },
      ],
    },
    failure: row.status === 'failed' ? { stage: 'structure', error: 'boom' } : null,
    syncDryrun: null,
  };
}

/** A minimal, valid `FunnelStage[]` fixture — mirrors RunsList.test.tsx's
 * own `stages()` helper. */
function stageRow(count: number, lastJobsOut: number) {
  const names = [
    'reconcile',
    'farm',
    'source',
    'compress',
    'structure',
    'assemble',
    'filter',
    'dedup',
    'rank',
    'sync',
  ];
  return names.slice(0, count).map((name, i) => ({
    name,
    jobsIn: 10,
    jobsOut: i === count - 1 ? lastJobsOut : 10,
    dropsByRule: {},
    elapsedMs: 100,
    attempts: 1,
  }));
}

const EVENTS: RunEventRow[] = [
  { ts: '2026-08-05T09:00:01.000Z', level: 'info', msg: 'stage started' },
  { ts: '2026-08-05T09:00:02.000Z', level: 'warn', msg: 'slow request' },
];

function stubFetch(
  opts: {
    noLocalDb?: boolean;
    serverError?: boolean;
    rows?: RunSummary[];
    /** Per-id override of the `/runs/:id` detail response — lets a test
     * hand back a specific result/failure shape (e.g. a health-gate-failing
     * 9-stage funnel, or a `result: null, failure: null` unrecorded row)
     * instead of the generic `detailFor` fixture. */
    detailOverrides?: Record<number, RunDetail>;
  } = {},
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // RunsPage now calls useRunControl (B-fix: threading onRun into
      // RunDetailView/DiagnosisPanel), which polls these two endpoints
      // independently of the runs list — stub them so the throw-on-
      // unknown-URL guard below doesn't fire for every test in this file.
      if (url.includes('/run-intents')) {
        return { ok: true, json: async () => ({ rows: [] }) } as unknown as Response;
      }
      if (url.includes('/api/daemon')) {
        return {
          ok: true,
          json: async () => ({
            state: 'stopped',
            pid: null,
            startedAt: null,
            lastTickAt: null,
            inFlight: null,
            profiles: [],
          }),
        } as unknown as Response;
      }
      const eventsMatch = url.match(/\/runs\/(\d+)\/events/);
      if (eventsMatch) {
        return {
          ok: true,
          json: async () => ({ rows: EVENTS, total: 2 }),
        } as unknown as Response;
      }
      const softErrorsMatch = url.match(/\/runs\/(\d+)\/soft-errors/);
      if (softErrorsMatch) {
        return {
          ok: true,
          json: async () => ({ total: 0, groups: [] }),
        } as unknown as Response;
      }
      const detailMatch = url.match(/\/runs\/(\d+)$/);
      if (detailMatch?.[1]) {
        const id = Number(detailMatch[1]);
        const override = opts.detailOverrides?.[id];
        if (override) {
          return { ok: true, json: async () => override } as unknown as Response;
        }
        const rows = opts.rows ?? ROWS;
        const row = rows.find((r) => r.id === id) ?? rows[0];
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

    // Events live behind EvidenceSection's disclosure, closed by default (B19).
    await userEvent.click(
      screen.getByTestId('evidence-disclosure-trigger') as HTMLElement,
    );
    expect(screen.getByText('stage started')).toBeInTheDocument();
  });

  it('renders a freshness chip derived from the runs-list query dataUpdatedAt (B23)', async () => {
    stubFetch();
    renderPage();

    // dataUpdatedAt lands within the same test tick as the resolved fetch,
    // so formatRelative's own <60s bucket ("just now") is what a fresh
    // successful poll always renders — no fake timers needed.
    await waitFor(() => {
      expect(screen.getByTestId('freshness-chip')).toHaveTextContent(/updated just now/i);
    });
  });

  it('shows a disconnected freshness chip on a server failure (B23, R11)', async () => {
    stubFetch({ serverError: true });
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('freshness-chip')).toHaveTextContent(/disconnected/i);
    });
    // Stalled ≠ disconnected (ux-notes §9, R11) — the chip's wording must
    // not read as a generic freshness update once the poll itself fails.
    expect(screen.getByTestId('freshness-chip')).not.toHaveTextContent(/updated/i);
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
        progress: null,
        catchupSlots: null,
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

  it('classifies passed/crashed list rows via fetched RunDetail, not the bare RunSummary fallback (regression)', async () => {
    // `listRuns()` — the real `/api/profiles/:name/runs` response — only
    // ever returns RunSummary rows (no `result`/`failure`). classifyOutcome
    // can only resolve produced/empty/degraded/unrecorded from a RunDetail,
    // so RunsPage must hydrate these rows with fetched detail before
    // RunsList renders them, or every 'passed' row degrades and every
    // truly-unrecorded 'crashed' row reads as generic 'crashed'.
    const rows: RunSummary[] = [
      {
        id: 10,
        date: '2026-08-07',
        timeDir: '09-00',
        kind: 'run',
        resumedFrom: null,
        status: 'passed',
        startedAt: '2026-08-07T09:00:00.000Z',
        finishedAt: '2026-08-07T09:05:00.000Z',
        heartbeatAt: '2026-08-07T09:05:00.000Z',
        progress: null,
        catchupSlots: null,
      },
      {
        id: 11,
        date: '2026-08-07',
        timeDir: '08-00',
        kind: 'run',
        resumedFrom: null,
        status: 'passed',
        startedAt: '2026-08-07T08:00:00.000Z',
        finishedAt: '2026-08-07T08:05:00.000Z',
        heartbeatAt: '2026-08-07T08:05:00.000Z',
        progress: null,
        catchupSlots: null,
      },
      {
        id: 12,
        date: '2026-08-07',
        timeDir: '07-00',
        kind: 'run',
        resumedFrom: null,
        status: 'passed',
        startedAt: '2026-08-07T07:00:00.000Z',
        finishedAt: '2026-08-07T07:05:00.000Z',
        heartbeatAt: '2026-08-07T07:05:00.000Z',
        progress: null,
        catchupSlots: null,
      },
      {
        id: 13,
        date: '2026-08-07',
        timeDir: '06-00',
        kind: 'run',
        resumedFrom: null,
        status: 'crashed',
        startedAt: '2026-08-07T06:00:00.000Z',
        finishedAt: '2026-08-07T06:01:00.000Z',
        heartbeatAt: '2026-08-07T06:01:00.000Z',
        progress: null,
        catchupSlots: null,
      },
    ];
    const detailOverrides: Record<number, RunDetail> = {
      10: {
        ...(rows[0] as RunSummary),
        result: { stages: stageRow(10, 7) },
        failure: null,
        syncDryrun: null,
      }, // produced: last stage jobsOut > 0
      11: {
        ...(rows[1] as RunSummary),
        result: { stages: stageRow(10, 0) },
        failure: null,
        syncDryrun: null,
      }, // empty: all 10 stages, zero-yield, health gate passes
      12: {
        ...(rows[2] as RunSummary),
        result: { stages: stageRow(9, 0) },
        failure: null,
        syncDryrun: null,
      }, // degraded: only 9 stages recorded, fails the health gate
      13: {
        ...(rows[3] as RunSummary),
        result: null,
        failure: null,
        syncDryrun: null,
      }, // unrecorded: crashed with both blobs genuinely null
    };
    stubFetch({ rows, detailOverrides });
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByTestId('run-row')).toHaveLength(4);
    });

    await waitFor(() => {
      const kinds = new Map(
        screen
          .getAllByTestId('run-row')
          .map((el) => [
            Number(el.getAttribute('data-run-id')),
            el.getAttribute('data-outcome-kind'),
          ]),
      );
      expect(kinds.get(10)).toBe('produced');
      expect(kinds.get(11)).toBe('empty');
      expect(kinds.get(12)).toBe('degraded');
      expect(kinds.get(13)).toBe('unrecorded');
    });
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
