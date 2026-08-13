import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunProgress, RunSummary } from '../../lib/api/types';
import { LiveRunHeader, type LiveRunHeaderProps } from './LiveRunHeader';
// Vite's `?raw` import loads this module's own source as a plain string —
// the mechanism for the grep-checkable "no useRunEvents reference" assertion
// (Step 3/5), sidestepping `import.meta.url` not resolving to a `file:` URL
// under vitest's jsdom environment.
import source from './LiveRunHeader.tsx?raw';

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
    catchupSlots: null,
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

function renderHeader(run: RunSummary, extra: Partial<LiveRunHeaderProps> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LiveRunHeader profile="rajni" run={run} {...extra} />
    </QueryClientProvider>,
  );
}

describe('LiveRunHeader — no dedicated events poll (R12)', () => {
  it('never references useRunEvents in its own source (grep-checkable, AC per B22)', () => {
    expect(source).not.toMatch(/useRunEvents/);
    expect(source).not.toMatch(/runEventsQuery/);
  });
});

describe('LiveRunHeader — stage/position from run.progress', () => {
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
});

describe('LiveRunHeader — three liveness states (AC8, AC16)', () => {
  it('alive: fresh heartbeat renders a pulsing-dot/live treatment', async () => {
    const { container } = renderHeader(
      makeRun({ heartbeatAt: new Date().toISOString() }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-run-heartbeat')).toHaveTextContent('Alive');
    });
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByTestId('live-run-retry')).toBeNull();
  });

  it('stalled: connected but no heartbeat renders activity-off + "No heartbeat for Nm"', async () => {
    const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const { container } = renderHeader(makeRun({ heartbeatAt: old }), {
      pollError: false,
    });

    await waitFor(() => {
      expect(screen.getByTestId('live-run-heartbeat')).toHaveTextContent(
        /No heartbeat for \d+m/,
      );
    });
    expect(container.querySelector('.lucide-heart-off')).not.toBeNull();
    expect(screen.queryByTestId('live-run-retry')).toBeNull();
  });

  it('disconnected: a failing poll renders wifi-off + "Disconnected — last update Ns ago" with [Retry]', async () => {
    const { container } = renderHeader(
      makeRun({ heartbeatAt: new Date().toISOString() }),
      {
        pollError: true,
        lastUpdatedAt: Date.now() - 47_000,
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-run-heartbeat')).toHaveTextContent(
        /Disconnected — last update \d+s ago/,
      );
    });
    expect(container.querySelector('.lucide-wifi-off')).not.toBeNull();
    expect(screen.getByTestId('live-run-retry')).toHaveTextContent('Retry');
  });

  it('stalled and disconnected render different text and different icon classes from each other', async () => {
    const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const stalled = renderHeader(makeRun({ heartbeatAt: old }));
    await waitFor(() => {
      expect(stalled.getByTestId('live-run-heartbeat')).toHaveTextContent(
        /No heartbeat for/,
      );
    });
    const stalledText = stalled.getByTestId('live-run-heartbeat').textContent;
    const stalledIcon = stalled.container.querySelector('.lucide-heart-off');
    expect(stalledIcon).not.toBeNull();
    stalled.unmount();

    const disconnected = renderHeader(
      makeRun({ heartbeatAt: new Date().toISOString() }),
      {
        pollError: true,
        lastUpdatedAt: Date.now() - 5_000,
      },
    );
    await waitFor(() => {
      expect(disconnected.getByTestId('live-run-heartbeat')).toHaveTextContent(
        /Disconnected/,
      );
    });
    const disconnectedText = disconnected.getByTestId('live-run-heartbeat').textContent;
    const disconnectedIcon = disconnected.container.querySelector('.lucide-wifi-off');
    expect(disconnectedIcon).not.toBeNull();

    expect(stalledText).not.toEqual(disconnectedText);
    expect(disconnected.container.querySelector('.lucide-heart-off')).toBeNull();
    expect(stalled.container.querySelector('.lucide-wifi-off')).toBeNull();
  });
});
