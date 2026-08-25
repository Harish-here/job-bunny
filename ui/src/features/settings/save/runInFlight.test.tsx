import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runsApi from '../../runs/runs.api';
import { useRunInFlight } from './runInFlight';

vi.mock('../../runs/runs.api', () => ({ listRuns: vi.fn() }));

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useRunInFlight', () => {
  it('is undefined while loading, then true when the latest run is running', async () => {
    vi.mocked(runsApi.listRuns).mockResolvedValue({
      rows: [{ id: 1, status: 'running' } as never],
      total: 1,
      limit: 1,
      offset: 0,
    });
    const { result } = renderHook(() => useRunInFlight('rajni'), { wrapper: wrapper() });
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(true));
    expect(runsApi.listRuns).toHaveBeenCalledWith('rajni', { limit: 1 });
  });

  it('is false when the latest run is not running', async () => {
    vi.mocked(runsApi.listRuns).mockResolvedValue({
      rows: [{ id: 1, status: 'completed' } as never],
      total: 1,
      limit: 1,
      offset: 0,
    });
    const { result } = renderHook(() => useRunInFlight('rajni'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('is false when there are no runs at all', async () => {
    vi.mocked(runsApi.listRuns).mockResolvedValue({
      rows: [],
      total: 0,
      limit: 1,
      offset: 0,
    });
    const { result } = renderHook(() => useRunInFlight('rajni'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current).toBe(false));
  });
});
