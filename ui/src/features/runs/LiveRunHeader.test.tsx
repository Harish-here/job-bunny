import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunProgress, RunSummary } from '../../lib/api/types';
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
    progress: null,
    ...over,
  };
}

function makeProgress(over: Partial<RunProgress> = {}): RunProgress {
  return {
    stage: 'filter',
    stageIndex: 7,
    stageTotal: 10,
    stageStartedAt: '2026-08-08T10:00:00.000Z',
    updatedAt: '2026-08-08T10:00:00.000Z',
    itemCurrent: null,
    itemTotal: null,
    ...over,
  };
}

function renderHeader(run: RunSummary) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LiveRunHeader profile="rajni" run={run} />
    </QueryClientProvider>,
  );
}

describe('LiveRunHeader', () => {
  it('renders the stage text and progress from run.progress', async () => {
    renderHeader(makeRun({ progress: makeProgress() }));

    await waitFor(() => {
      expect(screen.getByTestId('live-run-stage')).toHaveTextContent(
        'Running — filter 7/10',
      );
    });
  });

  it('renders "Running — starting…" when run.progress is null', async () => {
    renderHeader(makeRun({ progress: null }));

    await waitFor(() => {
      expect(screen.getByTestId('live-run-stage')).toHaveTextContent(
        'Running — starting…',
      );
    });
  });

  it('renders Alive for a fresh heartbeat', async () => {
    renderHeader(makeRun({ heartbeatAt: new Date().toISOString() }));

    await waitFor(() => {
      expect(screen.getByTestId('live-run-heartbeat')).toHaveTextContent('Alive');
    });
  });

  it('renders the stale heartbeat message for a heartbeat over 10 minutes old', async () => {
    const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    renderHeader(makeRun({ heartbeatAt: old }));

    await waitFor(() => {
      expect(screen.getByTestId('live-run-heartbeat')).toHaveTextContent(
        'No heartbeat for over 10 minutes',
      );
    });
  });

  it('renders the no-heartbeat-yet message when heartbeatAt is null', async () => {
    renderHeader(makeRun({ heartbeatAt: null }));

    await waitFor(() => {
      expect(screen.getByTestId('live-run-heartbeat')).toHaveTextContent(
        'No heartbeat yet',
      );
    });
  });
});
