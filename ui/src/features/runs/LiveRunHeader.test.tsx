import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('LiveRunHeader — catch-up extension, including the ETA computation (blueprint 1.6)', () => {
  const STARTED_AT = '2026-08-08T10:00:00.000Z';
  const STARTED_MS = Date.parse(STARTED_AT);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function catchupRun(
    elapsedMinutes: number,
    over: Partial<RunSummary> = {},
  ): RunSummary {
    const now = STARTED_MS + elapsedMinutes * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    return makeRun({
      kind: 'catchup',
      startedAt: STARTED_AT,
      heartbeatAt: new Date(now).toISOString(),
      catchupSlots: ['14:00', '16:30', '19:00'],
      progress: makeProgress({ stage: 'farm', stageIndex: 2, stageTotal: 10 }),
      ...over,
    });
  }

  it('(a) renders the exact ETA arithmetic result for a known fixture', async () => {
    renderHeader(catchupRun(8), { estimatedDurationMs: 1_140_000 });

    await waitFor(() => {
      expect(screen.getByText('~11 min left')).toBeTruthy();
    });
  });

  it('(b) catchup-banner-stop-unavailable shares the same computed value as the eta', async () => {
    renderHeader(catchupRun(8), { estimatedDurationMs: 1_140_000 });

    await waitFor(() => {
      expect(screen.getByText('Runs to completion — about 11 min left.')).toBeTruthy();
    });
  });

  it('(c) an elapsed time exceeding the estimate clamps to "~0 min left", never negative', async () => {
    renderHeader(catchupRun(25), { estimatedDurationMs: 1_140_000 });

    await waitFor(() => {
      expect(screen.getByText('~0 min left')).toBeTruthy();
      expect(screen.getByText('Runs to completion — about 0 min left.')).toBeTruthy();
    });
    expect(screen.queryByText(/-\d+ min left/)).toBeNull();
  });

  it('(d) estimatedDurationMs: null renders the elapsed-only fallback, no minutes clause', async () => {
    renderHeader(catchupRun(8), { estimatedDurationMs: null });

    await waitFor(() => {
      const eta = screen.getByTestId('live-run-heartbeat').textContent ?? '';
      expect(eta).toContain('elapsed');
      expect(eta).not.toContain('min left');
      expect(screen.getByText('Runs to completion.')).toBeTruthy();
    });
  });

  it('(e) catchup-banner-standin joins all slot times exactly as the mockup shows', async () => {
    renderHeader(catchupRun(8), { estimatedDurationMs: 1_140_000 });

    await waitFor(() => {
      expect(
        screen.getByText('Standing in for 3 missed slots (14:00, 16:30, 19:00)'),
      ).toBeTruthy();
    });
  });

  it('(f) catchup-banner-stop is never present for any catch-up run state', async () => {
    const alive = renderHeader(catchupRun(8), { estimatedDurationMs: 1_140_000 });
    await waitFor(() => {
      expect(alive.getByText('~11 min left')).toBeTruthy();
    });
    expect(alive.queryByTestId('catchup-banner-stop')).toBeNull();
    expect(alive.container.querySelector('[data-qa="catchup-banner-stop"]')).toBeNull();
    alive.unmount();

    const stalled = renderHeader(
      catchupRun(8, { heartbeatAt: new Date(STARTED_MS - 11 * 60_000).toISOString() }),
    );
    await waitFor(() => {
      expect(stalled.getByTestId('live-run-heartbeat')).toHaveTextContent(
        /No heartbeat for/,
      );
    });
    expect(stalled.container.querySelector('[data-qa="catchup-banner-stop"]')).toBeNull();
    stalled.unmount();

    const disconnected = renderHeader(catchupRun(8), {
      pollError: true,
      estimatedDurationMs: null,
    });
    await waitFor(() => {
      expect(disconnected.getByTestId('live-run-heartbeat')).toHaveTextContent(
        /Disconnected/,
      );
    });
    expect(
      disconnected.container.querySelector('[data-qa="catchup-banner-stop"]'),
    ).toBeNull();
  });

  it('(g) a non-catchup running row renders none of the catch-up-only data-qa ids (regression)', async () => {
    const { container } = renderHeader(
      makeRun({ kind: 'run', progress: makeProgress() }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-run-stage')).toHaveTextContent(
        'Running — filter 7/10',
      );
    });
    expect(container.querySelector('[data-qa="catchup-banner-standin"]')).toBeNull();
    expect(container.querySelector('[data-qa="catchup-banner-why"]')).toBeNull();
    expect(container.querySelector('[data-qa="catchup-banner-eta"]')).toBeNull();
    expect(
      container.querySelector('[data-qa="catchup-banner-stop-unavailable"]'),
    ).toBeNull();
    expect(container.querySelector('[data-qa="catchup-banner-stop"]')).toBeNull();
    // The root itself still carries the additive data-qa (same element as
    // every running row) — only the CONTENT branches on run.kind.
    expect(container.querySelector('[data-qa="catchup-banner"]')).not.toBeNull();
  });
});
