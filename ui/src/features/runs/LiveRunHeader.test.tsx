import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunEventRow, RunSummary } from '../../lib/api/types';
import { LiveRunHeader } from './LiveRunHeader';

function makeRun(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 5,
    date: '2026-08-08',
    timeDir: '10-00',
    kind: 'run',
    resumedFrom: null,
    status: 'running',
    startedAt: '2026-08-08T10:00:00.000Z',
    finishedAt: null,
    heartbeatAt: '2026-08-08T10:00:00.000Z',
    ...over,
  };
}

function stubEvents(rows: RunEventRow[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ rows, total: rows.length }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

function renderHeader(run: RunSummary) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LiveRunHeader profile="rajni" run={run} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LiveRunHeader', () => {
  it('renders the stage text and progress when events resolve a stage', async () => {
    stubEvents([{ ts: 't', level: 'info', msg: 'filter: starting' }]);
    renderHeader(makeRun());

    await waitFor(() => {
      expect(screen.getByTestId('live-run-stage')).toHaveTextContent(
        'Running — filter 7/10',
      );
    });
  });

  it('renders "Running — starting…" when no stage has logged yet', async () => {
    stubEvents([]);
    renderHeader(makeRun());

    await waitFor(() => {
      expect(screen.getByTestId('live-run-stage')).toHaveTextContent(
        'Running — starting…',
      );
    });
  });

  it('renders Alive for a fresh heartbeat', async () => {
    stubEvents([]);
    renderHeader(makeRun({ heartbeatAt: new Date().toISOString() }));

    await waitFor(() => {
      expect(screen.getByTestId('live-run-heartbeat')).toHaveTextContent('Alive');
    });
  });

  it('renders the stale heartbeat message for a heartbeat over 10 minutes old', async () => {
    stubEvents([]);
    const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    renderHeader(makeRun({ heartbeatAt: old }));

    await waitFor(() => {
      expect(screen.getByTestId('live-run-heartbeat')).toHaveTextContent(
        'No heartbeat for over 10 minutes',
      );
    });
  });

  it('renders the no-heartbeat-yet message when heartbeatAt is null', async () => {
    stubEvents([]);
    renderHeader(makeRun({ heartbeatAt: null }));

    await waitFor(() => {
      expect(screen.getByTestId('live-run-heartbeat')).toHaveTextContent(
        'No heartbeat yet',
      );
    });
  });
});
