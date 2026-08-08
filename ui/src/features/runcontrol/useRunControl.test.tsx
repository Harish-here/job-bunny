import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GetRunResponse,
  ListRunEventsResponse,
  ListRunsResponse,
  RunSummary,
} from '../../lib/api/types';
import * as runsApi from '../runs/runs.api';
import { runsKeys } from '../runs/runs.queries';
import * as intentsApi from './intents.api';
import { useRunControl } from './useRunControl';

vi.mock('../runs/runs.api', () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  listRunEvents: vi.fn(),
}));
vi.mock('./intents.api', () => ({
  listRunIntents: vi.fn(),
  requestRunIntent: vi.fn(),
  cancelRunIntent: vi.fn(),
}));

function emptyRuns(): ListRunsResponse {
  return { rows: [], total: 0, limit: 100, offset: 0 };
}
function emptyEvents(): ListRunEventsResponse {
  return { rows: [], total: 0, limit: 500, offset: 0 };
}

function runRow(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 42,
    date: '2026-08-08',
    timeDir: '09-00',
    kind: 'run',
    resumedFrom: null,
    status: 'running',
    startedAt: '2026-08-08T09:00:00.000Z',
    finishedAt: null,
    heartbeatAt: null,
    ...over,
  };
}

function runDetail(over: Partial<RunSummary> = {}): GetRunResponse {
  return { ...runRow(over), result: null, failure: null, syncDryrun: null };
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, Wrapper };
}

function stubBaseline() {
  vi.mocked(runsApi.listRuns).mockResolvedValue(emptyRuns());
  vi.mocked(runsApi.listRunEvents).mockResolvedValue(emptyEvents());
  vi.mocked(runsApi.getRun).mockResolvedValue(runDetail());
  vi.mocked(intentsApi.listRunIntents).mockResolvedValue({ rows: [] });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useRunControl', () => {
  it('an `error`-kind outcome surfaces via `error` instead of being treated as a success', async () => {
    stubBaseline();
    vi.mocked(intentsApi.requestRunIntent).mockResolvedValue({
      kind: 'error',
      message: 'HTTP 500',
    });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useRunControl('rajni'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.state.kind).toBe('idle'));
    await act(async () => {
      result.current.onRun();
    });

    await waitFor(() => expect(result.current.error).toBe('HTTP 500'));
    // A failed request must not be indistinguishable from a queued run.
    expect(result.current.state.kind).toBe('idle');
  });

  it('a cancel rejection surfaces via `error`', async () => {
    stubBaseline();
    vi.mocked(intentsApi.listRunIntents).mockResolvedValue({
      rows: [
        {
          id: 7,
          requestedAt: '2026-08-08T09:00:00.000Z',
          status: 'pending',
          claimedRunId: null,
        },
      ],
    });
    vi.mocked(intentsApi.cancelRunIntent).mockRejectedValue(new Error('cancel failed'));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useRunControl('rajni'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.state.kind).toBe('queued'));
    await act(async () => {
      result.current.onCancel();
    });

    await waitFor(() => expect(result.current.error).toBe('cancel failed'));
  });

  it('a 409 sets conflict, refreshes the runs list, and the auto-clear effect drops the conflict once that run is no longer running', async () => {
    stubBaseline();
    vi.mocked(intentsApi.requestRunIntent).mockResolvedValue({
      kind: 'run_in_progress',
      runId: 42,
    });
    const { qc, Wrapper } = makeWrapper();
    const { result } = renderHook(() => useRunControl('rajni'), { wrapper: Wrapper });

    await waitFor(() => expect(runsApi.listRuns).toHaveBeenCalledTimes(1));

    await act(async () => {
      result.current.onRun();
    });

    await waitFor(() =>
      expect(result.current.state).toEqual({ kind: 'conflict', runId: 42 }),
    );
    // `run_in_progress` must invalidate the runs list too, not just the
    // intents list — otherwise the run that caused the 409 never surfaces.
    await waitFor(() => expect(runsApi.listRuns).toHaveBeenCalledTimes(2));

    // Simulate that refetch resolving with the run finished, not running.
    // An explicit later `updatedAt` keeps this deterministic regardless of
    // how many real milliseconds elapsed above.
    act(() => {
      qc.setQueryData(
        runsKeys.list('rajni'),
        {
          rows: [runRow({ status: 'passed', finishedAt: new Date().toISOString() })],
          total: 1,
          limit: 100,
          offset: 0,
        },
        { updatedAt: Date.now() + 60_000 },
      );
    });

    await waitFor(() => expect(result.current.state.kind).not.toBe('conflict'));
    expect(result.current.state.kind).toBe('done');
  });
});
